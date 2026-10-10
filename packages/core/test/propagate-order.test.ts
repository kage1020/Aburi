import type { Confidence, Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import {
  type PropagateInput,
  propagateEffects,
  reverseTopoOrder,
  type SccNode,
} from "../src/propagate"
import { makeSymbol } from "./fixtures/ir"
import { edge, effect } from "./fixtures/propagate"

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
    expect(reverseTopoOrder([scc(0, [2]), scc(1, [2]), scc(2, [])])).toEqual([2, 0, 1])
  })

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

    expect(byId(reversed)).toEqual(byId(forward))
  })

  it("sorts a hub's propagated entries by (effectId, target)", () => {
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

const SCALE = 8
const SMALL = 10_000

const MAX_RATIO = 40

const OBVIOUS_RATIO = 60

const TIMEOUT_MS = 300_000

function scaleGraph(total: number): PropagateInput {
  const idOf = (i: number): string => `ts:src/m${String(i).padStart(6, "0")}.ts#f`
  const symbols = Array.from({ length: total }, (_, i) => makeSymbol(idOf(i)))
  const edges: CallEdge[] = []
  for (let i = 0; i + 1 < total; i += 5) edges.push(edge(idOf(i), idOf(i + 1)))
  return { symbols, edges }
}

function meanCost(input: PropagateInput, reps: number): number {
  const started = performance.now()
  for (let i = 0; i < reps; i++) propagateEffects(input)
  return (performance.now() - started) / reps
}

describe("propagation scale", () => {
  let small: PropagateInput
  let large: PropagateInput
  beforeAll(() => {
    small = scaleGraph(SMALL)
    large = scaleGraph(SMALL * SCALE)
  }, TIMEOUT_MS)

  it("is built from the shape the cost model assumes", () => {
    expect(small.edges).toHaveLength(SMALL / 5)
    expect(propagateEffects(small).stats.sccCount).toBe(SMALL)
  })

  it("grows with the log of the graph, not with its square", { timeout: TIMEOUT_MS }, () => {
    meanCost(small, 2)

    const ratios: number[] = []
    for (let round = 0; round < 4; round++) {
      const largeFirst = round % 2 === 0
      const measure = (): number => {
        const first = largeFirst ? meanCost(large, 1) : meanCost(small, SCALE)
        const second = largeFirst ? meanCost(small, SCALE) : meanCost(large, 1)
        return largeFirst ? first / second : second / first
      }

      let ratio = measure()
      if (ratio >= OBVIOUS_RATIO) {
        ratio = measure()
        expect(ratio, `round ${round} cost ratio at ${SCALE}x the symbols, twice`).toBeLessThan(
          OBVIOUS_RATIO,
        )
      }
      ratios.push(ratio)
    }

    const sorted = [...ratios].sort((a, b) => a - b)
    const median = ((sorted[1] as number) + (sorted[2] as number)) / 2
    expect(
      median,
      `cost ratios at ${SCALE}x the symbols: ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThan(MAX_RATIO)
  })

  it("returns every symbol exactly once at both sizes", { timeout: TIMEOUT_MS }, () => {
    expect(new Set(propagateEffects(small).symbols.map((sym) => sym.id)).size).toBe(SMALL)
    expect(new Set(propagateEffects(large).symbols.map((sym) => sym.id)).size).toBe(SMALL * SCALE)
  })
})
