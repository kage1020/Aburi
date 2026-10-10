import type { SymbolId } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { type PropagateInput, propagateEffects } from "../src/propagate"
import { reverseTopoOrder, type SccNode } from "../src/propagate-graph"
import { makeSymbol } from "./fixtures/ir"
import { edge } from "./fixtures/propagate"

/** A condensed graph from each SCC's outgoing SCC indices; `reverseTopoOrder` reads nothing else. */
function condensed(outSccs: readonly number[][]): SccNode[] {
  return outSccs.map((out, index) => ({
    id: `scc-${index}`,
    members: [`ts:src/n${index}.ts#f` as SymbolId],
    outSccs: [...out],
    outEdgeConfidence: new Map(out.map((o) => [o, "high"])),
  }))
}

describe("reverseTopoOrder", () => {
  it.each<[string, number[][], number[]]>([
    ["nothing for an empty graph", [], []],
    ["independent SCCs in ascending index", [[], [], []], [0, 1, 2]],
    ["a chain callee-first", [[1], [2], []], [2, 1, 0]],
    ["the smaller index when several become ready together", [[2], [2], []], [2, 0, 1]],
    [
      "a smaller index released after a larger one was already ready",
      [[3], [0], [1], [], []],
      [3, 0, 1, 2, 4],
    ],
    [
      "a batch released at once in ascending order",
      [[4], [4], [4], [4], [], []],
      [4, 0, 1, 2, 3, 5],
    ],
  ])("emits %s", (_case, outSccs, order) => {
    expect(reverseTopoOrder(condensed(outSccs))).toEqual(order)
  })

  it("emits every SCC exactly once, callee before caller", () => {
    const graph = condensed([[1, 2], [3], [3], [4], []])

    const order = reverseTopoOrder(graph)

    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    const position = new Map(order.map((index, at) => [index, at]))
    for (const [index, node] of graph.entries()) {
      for (const out of node.outSccs) {
        expect(position.get(out)).toBeLessThan(position.get(index) as number)
      }
    }
  })
})

const SCALE = 8
const SMALL = 10_000
const MAX_RATIO = 40
const OBVIOUS_RATIO = 60
const TIMEOUT_MS = 300_000

/** `total` symbols, one in five calling the next: mostly singleton SCCs, all ready at once. */
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
})
