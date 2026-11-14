import { costGrowth } from "@aburi/test-support"
import type { Confidence, SymbolId } from "@aburi/types"
import { beforeAll, describe, expect, it } from "vitest"
import type { CallEdge } from "../src/callgraph"
import { type PropagateInput, propagateEffects } from "../src/propagate"
import { reverseTopoOrder, type SccNode } from "../src/propagate-graph"
import { makeSymbol } from "./fixtures/ir"
import { edge, localEffect } from "./fixtures/propagate"

/** A condensed graph from each SCC's outgoing SCC indices; `reverseTopoOrder` reads nothing else. */
function condensed(outSccs: readonly number[][]): SccNode[] {
  return outSccs.map((out, index) => ({
    id: `scc-${index}`,
    members: [`ts:src/n${index}.ts#f` as SymbolId],
    outSccs: [...out],
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
const MAX_RATIO = 40
const OBVIOUS_RATIO = 60
const SAMPLE_MS = 100
const TIMEOUT_MS = 300_000

const idOf = (i: number): string => `ts:src/m${String(i).padStart(6, "0")}.ts#f`

/** `total` symbols, one in five calling the next: mostly singleton SCCs, all ready at once. */
function chainsGraph(total: number): PropagateInput {
  const symbols = Array.from({ length: total }, (_, i) => makeSymbol(idOf(i)))
  const edges: CallEdge[] = []
  for (let i = 0; i + 1 < total; i += 5) edges.push(edge(idOf(i), idOf(i + 1)))
  return { symbols, edges }
}

const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"]

/** `total` symbols calling round one cycle at mixed confidences, the first of them writing. */
function ringGraph(total: number): PropagateInput {
  const symbols = Array.from({ length: total }, (_, i) =>
    makeSymbol(idOf(i), {
      effects: i === 0 ? [localEffect({ id: "db.write", target: "x" })] : [],
    }),
  )
  const edges = symbols.map((_, i) =>
    edge(idOf(i), idOf((i + 1) % total), { confidence: CONFIDENCES[i % 3] as Confidence }),
  )
  return { symbols, edges }
}

describe.each<[string, (total: number) => PropagateInput, number]>([
  ["mostly singleton SCCs", chainsGraph, 10_000],
  ["one cycle", ringGraph, 2_000],
])("propagation scale over %s", (_shape, graph, size) => {
  let small: PropagateInput
  let large: PropagateInput
  beforeAll(() => {
    small = graph(size)
    large = graph(size * SCALE)
  }, TIMEOUT_MS)

  it("grows with the log of the graph, not with its square", { timeout: TIMEOUT_MS }, () => {
    const { median, ratios } = costGrowth(
      () => propagateEffects(small),
      () => propagateEffects(large),
      { rounds: 4, sampleMs: SAMPLE_MS, retryAt: OBVIOUS_RATIO },
    )

    expect(
      median,
      `cost ratios at ${SCALE}x the symbols: ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThan(MAX_RATIO)
  })
})
