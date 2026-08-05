import type { Confidence, Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { propagateEffects, reverseTopoOrder, type SccNode } from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"
import { edge, effect } from "./fixtures/propagate"

/**
 * `reverseTopoOrder` emits SCCs callee-first, breaking ties on the smallest SCC index as
 * effect-propagation.md §6 requires. These cases assert the permutation itself.
 *
 * They have to. The SCC aggregation downstream is commutative — every merge is a min/max
 * or a lexicographic-min, and both `derivedFrom` and the propagated entries are sorted
 * explicitly afterwards — so any valid topological order produces identical output today.
 * Driving this through `propagateEffects` therefore cannot distinguish a min-heap from a
 * LIFO stack, and a test suite that only did that would leave the tie-break unguarded
 * while appearing to cover it.
 */

/** Condensed-DAG node carrying only what `reverseTopoOrder` reads. */
function scc(index: number, outSccs: number[]): SccNode {
  return {
    id: `scc-${index}`,
    members: [`ts:src/n${index}.ts#f` as SymbolId],
    outSccs,
    outEdgeConfidence: new Map<number, Confidence>(outSccs.map((o) => [o, "high"])),
  }
}

describe("reverseTopoOrder — emitted permutation", () => {
  it("returns the empty order for an empty graph", () => {
    expect(reverseTopoOrder([])).toEqual([])
  })

  it("takes independent SCCs in ascending index", () => {
    expect(reverseTopoOrder([scc(0, []), scc(1, []), scc(2, [])])).toEqual([0, 1, 2])
  })

  it("emits a chain callee-first, reversing the declaration order", () => {
    // 0 -> 1 -> 2, so 2 has to be aggregated before 1, and 1 before 0.
    expect(reverseTopoOrder([scc(0, [1]), scc(1, [2]), scc(2, [])])).toEqual([2, 1, 0])
  })

  it("prefers the smaller index when several become ready together", () => {
    // 0 and 1 both depend on 2. Once 2 drains, both are ready in the same step and the
    // tie-break decides: ascending index, not insertion order.
    expect(reverseTopoOrder([scc(0, [2]), scc(1, [2]), scc(2, [])])).toEqual([2, 0, 1])
  })

  /**
   * The shape that forces a sift-up: a *smaller* index becomes ready while a larger one is
   * already waiting. 3 is ready immediately; draining it releases 0, which must surface
   * ahead of the queued 4. Without the sift-up the heap would hand back 4 first.
   */
  it("re-orders the ready set when a smaller index arrives after a larger one", () => {
    const condensed = [
      scc(0, [3]), //  released once 3 drains
      scc(1, [0]),
      scc(2, [1]),
      scc(3, []), //   ready at the start
      scc(4, []), //   ready at the start, larger than the 0 that arrives later
    ]

    expect(reverseTopoOrder(condensed)).toEqual([3, 0, 1, 2, 4])
  })

  /**
   * The mirror case, forcing a sift-down: several nodes are released at once and the heap
   * has to re-establish the minimum at the root after each pop.
   */
  it("keeps ascending order when a batch is released at once", () => {
    const condensed = [scc(0, [4]), scc(1, [4]), scc(2, [4]), scc(3, [4]), scc(4, []), scc(5, [])]

    expect(reverseTopoOrder(condensed)).toEqual([4, 0, 1, 2, 3, 5])
  })

  it("emits every SCC exactly once, callee before caller", () => {
    // A denser graph where the answer is easier to state as a property than as a literal.
    const condensed = [scc(0, [1, 2]), scc(1, [3]), scc(2, [3]), scc(3, [4]), scc(4, [])]

    const order = reverseTopoOrder(condensed)

    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    const position = new Map(order.map((idx, at) => [idx, at]))
    for (const [idx, node] of condensed.entries()) {
      for (const out of node.outSccs) {
        expect(position.get(out)).toBeLessThan(position.get(idx) as number)
      }
    }
  })
})

describe("propagation through the sweep", () => {
  it("reaches the far end of a chain in one pass", () => {
    const symbols = [
      makeSymbol("ts:src/a.ts#a"),
      makeSymbol("ts:src/b.ts#b"),
      makeSymbol("ts:src/c.ts#c"),
      makeSymbol("ts:src/d.ts#d", { effects: [effect("db.write", "prisma.user.create")] }),
    ]
    const edges = [
      edge("ts:src/a.ts#a", "ts:src/b.ts#b"),
      edge("ts:src/b.ts#b", "ts:src/c.ts#c"),
      edge("ts:src/c.ts#c", "ts:src/d.ts#d"),
    ]

    const result = propagateEffects({ symbols, edges })

    // Each hop names its immediate callee (effect-propagation.md §5.2), not the origin —
    // so reaching `a` at all proves the sweep visited d, c and b ahead of it.
    const derivedFrom = (id: string) =>
      (result.symbols.find((s) => s.id === id)?.effects ?? [])
        .filter((e) => e.propagated === true)
        .flatMap((e) => e.derivedFrom ?? [])
    expect(derivedFrom("ts:src/a.ts#a")).toEqual(["ts:src/b.ts#b"])
    expect(derivedFrom("ts:src/b.ts#b")).toEqual(["ts:src/c.ts#c"])
    expect(derivedFrom("ts:src/c.ts#c")).toEqual(["ts:src/d.ts#d"])
  })

  it("produces the same document when the inputs are presented in reverse", () => {
    const symbols = [
      makeSymbol("ts:src/top.ts#top"),
      makeSymbol("ts:src/left.ts#left", { effects: [effect("db.read", "prisma.user.findMany")] }),
      makeSymbol("ts:src/right.ts#right", { effects: [effect("db.write", "prisma.user.create")] }),
      makeSymbol("ts:src/bottom.ts#bottom", { effects: [effect("network.http", "fetch")] }),
    ]
    const edges = [
      edge("ts:src/top.ts#top", "ts:src/left.ts#left"),
      edge("ts:src/top.ts#top", "ts:src/right.ts#right"),
      edge("ts:src/left.ts#left", "ts:src/bottom.ts#bottom"),
      edge("ts:src/right.ts#right", "ts:src/bottom.ts#bottom"),
    ]

    const byId = (r: { symbols: readonly IRSymbol[] }) =>
      [...r.symbols].sort((a, b) => (a.id < b.id ? -1 : 1))

    const forward = propagateEffects({ symbols, edges })
    const reversed = propagateEffects({
      symbols: [...symbols].reverse(),
      edges: [...edges].reverse(),
    })

    // Full equality, not just the effect ids: `target`, `confidence`, `plugin` and
    // `derivedFrom` all have to land identically for the IR bytes to match.
    expect(byId(reversed)).toEqual(byId(forward))
  })

  it("sorts a hub's propagated entries by (effectId, target)", () => {
    // Targets are `q0..q49`, so the expected order is by code point — `q1` before `q10`
    // before `q2` — which is what pins the sort rather than the insertion order.
    const leaves = Array.from({ length: 50 }, (_, i) =>
      makeSymbol(`ts:src/leaf${String(i).padStart(3, "0")}.ts#leaf`, {
        effects: [effect("db.read", `q${i}`)],
      }),
    )
    const symbols = [makeSymbol("ts:src/hub.ts#hub"), ...leaves]
    const edges = leaves.map((leaf) => edge("ts:src/hub.ts#hub", leaf.id))

    const hub = propagateEffects({ symbols, edges }).symbols.find(
      (s) => s.id === "ts:src/hub.ts#hub",
    )
    const targets = (hub?.effects ?? []).map((e) => e.target)

    expect(targets).toHaveLength(50)
    expect(targets).toEqual([...targets].sort())
  })
})

describe("propagation scale", () => {
  /**
   * Out-degree-zero symbols are the ordinary case — most symbols call nothing — and they
   * all become ready at once, which is what decides how the ready set behaves. Re-sorting
   * it on every dequeue made this quadratic.
   *
   * The budget is set against the *old* cost, not the new one: 40k took ~14 s before and
   * ~150 ms after, so 3 s leaves the fixed implementation roughly 20x of headroom while
   * still failing a reintroduced quadratic by a factor of ~5 even on a much faster runner.
   * A fifth of the symbols call something, so the heap is exercised rather than merely
   * drained in one pass.
   */
  it("stays sub-quadratic on 40k symbols", () => {
    const total = 40_000
    const symbols = Array.from({ length: total }, (_, i) =>
      makeSymbol(`ts:src/m${String(i).padStart(6, "0")}.ts#f`),
    )
    const edges = symbols
      .filter((_, i) => i % 5 === 0 && i + 1 < total)
      .map((s, i) => edge(s.id, symbols[(i * 5 + 1) % total]?.id ?? s.id))

    const started = performance.now()
    const result = propagateEffects({ symbols, edges })
    const elapsed = performance.now() - started

    expect(result.symbols).toHaveLength(total)
    expect(elapsed).toBeLessThan(3_000)
  })
})
