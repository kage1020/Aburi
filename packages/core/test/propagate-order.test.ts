import type { Effect, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { propagateEffects } from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"

/**
 * The reverse-topological sweep order is what makes effect propagation deterministic: a
 * callee is aggregated before every caller that reaches it, and equal-priority SCCs are
 * taken in ascending index. `derivedFrom` records the chain in that order, so a change to
 * it is visible in the IR bytes and in every fingerprint downstream of them.
 *
 * These cases pin the observable consequences — chain, diamond, star, cycle, disconnected
 * — so the queue implementation can be replaced without silently reordering anything.
 */

function local(id: string, target: string): Effect {
  return {
    id,
    target,
    line: 1,
    plugin: "effects-test",
    confidence: "high",
    derivedBy: `effects-plugin:test:${id}`,
  }
}

function edge(from: string, to: string): CallEdge {
  return {
    from: from as CallEdge["from"],
    to: to as CallEdge["to"],
    via: "call",
    confidence: "high",
    line: 1,
  }
}

function sym(id: string, effects: Effect[] = []): IRSymbol {
  return makeSymbol(id, { effects })
}

function symbolOf(symbols: readonly IRSymbol[], id: string): IRSymbol {
  const found = symbols.find((s) => s.id === id)
  if (found === undefined) throw new Error(`missing symbol ${id}`)
  return found
}

/** Effect ids a Symbol carries by propagation rather than local detection. */
function propagatedIds(symbols: readonly IRSymbol[], id: string): string[] {
  return symbolOf(symbols, id)
    .effects.filter((e) => e.propagated === true)
    .map((e) => e.id)
    .sort()
}

/**
 * `derivedFrom` is the *direct* upstream callee, not the origin (effect-propagation.md
 * §5.2): for `A → B → C` with a local effect on `C`, `A`'s entry reads `[B]`.
 */
function derivedFromOf(symbols: readonly IRSymbol[], id: string, effectId: string): string[] {
  return symbolOf(symbols, id)
    .effects.filter((e) => e.propagated === true && e.id === effectId)
    .flatMap((e) => e.derivedFrom ?? [])
    .sort()
}

describe("propagation sweep order", () => {
  it("carries an effect the length of a chain, in one pass", () => {
    const symbols = [
      sym("ts:src/a.ts#a"),
      sym("ts:src/b.ts#b"),
      sym("ts:src/c.ts#c"),
      sym("ts:src/d.ts#d", [local("db.write", "prisma.user.create")]),
    ]
    const edges = [
      edge("ts:src/a.ts#a", "ts:src/b.ts#b"),
      edge("ts:src/b.ts#b", "ts:src/c.ts#c"),
      edge("ts:src/c.ts#c", "ts:src/d.ts#d"),
    ]

    const result = propagateEffects({ symbols, edges })

    // Reaching `a` at all requires the sweep to visit d, then c, then b before it.
    for (const id of ["ts:src/a.ts#a", "ts:src/b.ts#b", "ts:src/c.ts#c"]) {
      expect(propagatedIds(result.symbols, id)).toEqual(["db.write"])
    }
    // Each hop names its immediate callee, per §5.2 — not the origin.
    expect(derivedFromOf(result.symbols, "ts:src/a.ts#a", "db.write")).toEqual(["ts:src/b.ts#b"])
    expect(derivedFromOf(result.symbols, "ts:src/b.ts#b", "db.write")).toEqual(["ts:src/c.ts#c"])
    expect(derivedFromOf(result.symbols, "ts:src/c.ts#c", "db.write")).toEqual(["ts:src/d.ts#d"])
  })

  it("merges both arms of a diamond in a stable order", () => {
    const symbols = [
      sym("ts:src/top.ts#top"),
      sym("ts:src/left.ts#left", [local("db.read", "prisma.user.findMany")]),
      sym("ts:src/right.ts#right", [local("db.write", "prisma.user.create")]),
      sym("ts:src/bottom.ts#bottom", [local("network.http", "fetch")]),
    ]
    const edges = [
      edge("ts:src/top.ts#top", "ts:src/left.ts#left"),
      edge("ts:src/top.ts#top", "ts:src/right.ts#right"),
      edge("ts:src/left.ts#left", "ts:src/bottom.ts#bottom"),
      edge("ts:src/right.ts#right", "ts:src/bottom.ts#bottom"),
    ]

    const first = propagateEffects({ symbols, edges })
    // Same graph, edges and symbols presented in reverse: the sweep order is derived from
    // the id-sorted node list, so the result must not move.
    const second = propagateEffects({
      symbols: [...symbols].reverse(),
      edges: [...edges].reverse(),
    })

    const idsOf = (r: { symbols: readonly IRSymbol[] }) =>
      [...r.symbols].map((s) => `${s.id}:${s.effects.map((e) => e.id).join(",")}`).sort()
    expect(idsOf(second)).toEqual(idsOf(first))

    expect(propagatedIds(first.symbols, "ts:src/top.ts#top")).toEqual([
      "db.read",
      "db.write",
      "network.http",
    ])
    // Both arms contribute `network.http`, so its `derivedFrom` is the sorted union of the
    // two direct callees — the merge §5.2 describes.
    expect(derivedFromOf(first.symbols, "ts:src/top.ts#top", "network.http")).toEqual([
      "ts:src/left.ts#left",
      "ts:src/right.ts#right",
    ])
    expect(derivedFromOf(first.symbols, "ts:src/top.ts#top", "db.read")).toEqual([
      "ts:src/left.ts#left",
    ])
  })

  it("handles a hub with many leaves — the shape that grows the ready queue", () => {
    const leafCount = 50
    const leaves = Array.from({ length: leafCount }, (_, i) =>
      sym(`ts:src/leaf${String(i).padStart(3, "0")}.ts#leaf`, [local("db.read", `q${i}`)]),
    )
    const symbols = [sym("ts:src/hub.ts#hub"), ...leaves]
    const edges = leaves.map((leaf) => edge("ts:src/hub.ts#hub", leaf.id))

    const result = propagateEffects({ symbols, edges })

    // One propagated entry per distinct (effectId, target); the leaves use distinct targets.
    expect(symbolOf(result.symbols, "ts:src/hub.ts#hub").effects).toHaveLength(leafCount)
  })

  it("treats a cycle as one unit and still reaches what it calls", () => {
    const symbols = [
      sym("ts:src/a.ts#a"),
      sym("ts:src/b.ts#b"),
      sym("ts:src/sink.ts#sink", [local("db.write", "prisma.user.create")]),
    ]
    const edges = [
      edge("ts:src/a.ts#a", "ts:src/b.ts#b"),
      edge("ts:src/b.ts#b", "ts:src/a.ts#a"),
      edge("ts:src/b.ts#b", "ts:src/sink.ts#sink"),
    ]

    const result = propagateEffects({ symbols, edges })

    expect(propagatedIds(result.symbols, "ts:src/a.ts#a")).toEqual(["db.write"])
    expect(propagatedIds(result.symbols, "ts:src/b.ts#b")).toEqual(["db.write"])
    // `b` calls both `sink` and its SCC partner `a`, and by the time the entry is written
    // `a` carries the effect too — so both direct callees are recorded.
    expect(derivedFromOf(result.symbols, "ts:src/b.ts#b", "db.write")).toEqual([
      "ts:src/a.ts#a",
      "ts:src/sink.ts#sink",
    ])
    expect(result.stats.maxSccSize).toBe(2)
  })

  it("is idempotent — re-propagating an already-propagated set changes nothing", () => {
    const symbols = [sym("ts:src/a.ts#a"), sym("ts:src/b.ts#b", [local("db.write", "create")])]
    const edges = [edge("ts:src/a.ts#a", "ts:src/b.ts#b")]

    const once = propagateEffects({ symbols, edges })
    const twice = propagateEffects({ symbols: once.symbols, edges })

    expect(twice.symbols).toEqual(once.symbols)
  })
})

describe("propagation scale", () => {
  /**
   * Out-degree-zero symbols are the common case — most symbols call nothing — and they all
   * become ready at once, so this is the shape that decides how the ready queue behaves.
   * Sorting the queue on every dequeue makes it quadratic: 20k took roughly four seconds.
   * The bound is loose enough for a slow CI runner and still two orders of magnitude below
   * that.
   */
  it("stays sub-quadratic on 20k independent symbols", () => {
    const symbols = Array.from({ length: 20_000 }, (_, i) =>
      sym(`ts:src/m${String(i).padStart(6, "0")}.ts#f`),
    )

    const started = performance.now()
    const result = propagateEffects({ symbols, edges: [] })
    const elapsed = performance.now() - started

    expect(result.symbols).toHaveLength(20_000)
    expect(elapsed).toBeLessThan(2_000)
  })
})
