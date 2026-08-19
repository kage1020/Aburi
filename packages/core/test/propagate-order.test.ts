import type { Confidence, Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
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

/**
 * Out-degree-zero symbols are the ordinary case — most symbols call nothing — and they all
 * become ready at once, which is what decides how the ready set behaves. Re-sorting it on
 * every dequeue made the pass quadratic, and this is what stops that returning.
 *
 * **What is asserted is the shape, not the clock.** An elapsed-time budget measures the
 * machine as much as the algorithm: the same commit that runs in ~150 ms here took 6.4 s on
 * a loaded shared runner, which is a 42x deviation with no code behind it and is
 * indistinguishable at a glance from a real regression. Cost at two sizes cancels that —
 * a slow machine moves both measurements, a quadratic moves only the larger one.
 *
 * The graphs are the same shape at both sizes (a fifth of the symbols call something, so the
 * ready set is exercised rather than drained in one pass), so at 8x the symbols an
 * `n log n` pass costs 8 x (log 80k / log 10k) ≈ 9.8x and a quadratic one ≈ 64x.
 */
const SCALE = 8
const SMALL = 10_000

/**
 * Ratio above which the run is called a regression: the geometric midpoint of the two
 * measured populations rather than a figure from theory.
 *
 * The honest implementation was measured at medians of 8.1 to 16.8 over six runs of the full
 * package suite in parallel — the loaded regime the flake came from, not a quiet solo run —
 * with no single round above 21.5. Re-introducing the ready-set re-sort measured 95.4. The
 * midpoint of 16.8 and 95.4 is ~40, which leaves the honest path 2.4x of headroom and fails
 * the regression by the same factor.
 */
const MAX_RATIO = 40

/**
 * Ratio at which a single round decides the run on its own. No honest round has been
 * measured above 21.5, in six full-suite runs, and the re-sorting implementation measured
 * 81.2 and 95.4 in two runs of its own — so 60 separates the two populations with room on
 * both sides, and the median assertion still stands behind it when a round lands between.
 */
const OBVIOUS_RATIO = 60

/**
 * Explicit, and far above the honest path (~2 s here, and the slowest runner this suite has
 * met was 27x that). The package default of 30 s would let a loaded machine turn this into a
 * timeout, which is the same flake wearing a different costume; a regression reaches the
 * assertion and reports its ratio instead.
 *
 * Passed to the hook as well as to the cases. Building the two graphs takes about a second
 * here, and hooks are governed by `hookTimeout`, which nothing in this workspace raises from
 * its 10 s default — a loaded runner would fail there for the same reason and with a worse
 * message.
 */
const TIMEOUT_MS = 300_000

interface ScaleGraph {
  symbols: IRSymbol[]
  edges: ReturnType<typeof edge>[]
}

/** The fixture Symbols carry no effects, so every pass over one of these costs the same. */
function scaleGraph(total: number): ScaleGraph {
  const symbols = Array.from({ length: total }, (_, i) =>
    makeSymbol(`ts:src/m${String(i).padStart(6, "0")}.ts#f`),
  )
  const edges = symbols
    .filter((_, i) => i % 5 === 0 && i + 1 < total)
    .map((s, i) => edge(s.id, symbols[(i * 5 + 1) % total]?.id ?? s.id))
  return { symbols, edges }
}

/**
 * Mean cost of one pass over `input`.
 *
 * `reps` is what makes the two samples comparable: the small graph runs `SCALE` times, so
 * both samples span roughly the same wall time and a burst of interference lands on them
 * equally. Measuring one call each instead let the shorter sample's variance dominate the
 * ratio — it read 11 to 17 across runs where the paired form reads 8 to 17 under heavier
 * load.
 */
function meanCost(input: ScaleGraph, reps: number): number {
  const started = performance.now()
  for (let i = 0; i < reps; i++) propagateEffects(input)
  return (performance.now() - started) / reps
}

describe("propagation scale", () => {
  // Built once: the two graphs cost about a second to assemble, both cases need both, and
  // `propagateEffects` returns fresh Symbols rather than editing the ones it was handed.
  let small: ScaleGraph
  let large: ScaleGraph
  beforeAll(() => {
    small = scaleGraph(SMALL)
    large = scaleGraph(SMALL * SCALE)
  }, TIMEOUT_MS)

  it("grows with the log of the graph, not with its square", { timeout: TIMEOUT_MS }, () => {
    // Warm-up on the small graph only: what settles is the JIT's view of the code, which
    // does not depend on how much data it ran over. Warming on the large graph would put
    // a whole extra pass of the most expensive size in front of every run, including a
    // regressed one that cannot afford it.
    meanCost(small, 2)

    const ratios: number[] = []
    for (let round = 0; round < 3; round++) {
      const ratio = meanCost(large, 1) / meanCost(small, SCALE)
      // A round this far out is not the machine — it sits above every honest round ever
      // measured and below the cheapest regressed one. Stopping here costs one round
      // instead of three and says the ratio out loud, rather than leaving a timeout to
      // be interpreted, which is the diagnosis this test exists to stop guessing at.
      expect(ratio, `round ${round} cost ratio at ${SCALE}x the symbols`).toBeLessThan(
        OBVIOUS_RATIO,
      )
      ratios.push(ratio)
    }

    const median = [...ratios].sort((a, b) => a - b)[1] as number
    expect(
      median,
      `cost ratios at ${SCALE}x the symbols: ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThan(MAX_RATIO)
  })

  it("returns every symbol at both sizes", { timeout: TIMEOUT_MS }, () => {
    // The ratio says nothing about the answer being right, and a pass that dropped symbols
    // on the floor would be fast.
    expect(propagateEffects(small).symbols).toHaveLength(SMALL)
    expect(propagateEffects(large).symbols).toHaveLength(SMALL * SCALE)
  })
})
