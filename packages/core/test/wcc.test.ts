import { describe, expect, it } from "vitest"
import { computeWeaklyConnectedComponents } from "../src/wcc"

interface Node {
  key: string
}
const keyOf = (node: Node): string => node.key

type Edge = [string, string]

function components(keys: readonly string[], edges: readonly Edge[]): string[][] {
  return computeWeaklyConnectedComponents(
    keys.map((key) => ({ key })),
    edges.map(([from, to]): [Node, Node] => [{ key: from }, { key: to }]),
    keyOf,
  ).map((component) => component.map(keyOf))
}

describe("computeWeaklyConnectedComponents", () => {
  it.each<[string, string[], Edge[], string[][]]>([
    ["nothing for no nodes", [], [], []],
    ["one singleton per unconnected node", ["a", "b", "c"], [], [["a"], ["b"], ["c"]]],
    ["two nodes joined by an edge as one", ["a", "b"], [["a", "b"]], [["a", "b"]]],
    ["an edge written backwards the same way", ["a", "b"], [["b", "a"]], [["a", "b"]]],
    [
      "a directed cycle as one component",
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
      ],
      [["a", "b", "c"]],
    ],
    [
      "no bridge through a node outside the set",
      ["a", "b"],
      [
        ["a", "middle"],
        ["middle", "b"],
      ],
      [["a"], ["b"]],
    ],
    [
      "no connectivity from self-loops",
      ["a", "b"],
      [
        ["a", "a"],
        ["b", "b"],
      ],
      [["a"], ["b"]],
    ],
    [
      "repeated edges between one pair as one component",
      ["a", "b"],
      [
        ["a", "b"],
        ["a", "b"],
        ["b", "a"],
      ],
      [["a", "b"]],
    ],
    [
      "members in ascending key order",
      ["c", "a", "b"],
      [
        ["c", "a"],
        ["a", "b"],
      ],
      [["a", "b", "c"]],
    ],
    [
      "components in ascending order of their smallest key",
      ["m", "x", "a", "z", "b"],
      [
        ["m", "x"],
        ["a", "b"],
      ],
      [["a", "b"], ["m", "x"], ["z"]],
    ],
  ])("returns %s", (_case, keys, edges, expected) => {
    expect(components(keys, edges)).toEqual(expected)
  })

  it("returns the same components however the nodes and edges are ordered", () => {
    expect(
      components(
        ["d", "a", "c", "b"],
        [
          ["d", "c"],
          ["b", "a"],
        ],
      ),
    ).toEqual(
      components(
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["c", "d"],
        ],
      ),
    )
  })

  it("matches edge endpoints to nodes by key, not by object identity", () => {
    const a = { key: "a" }
    const b = { key: "b" }

    const result = computeWeaklyConnectedComponents([a, b], [[{ key: "a" }, b]], keyOf)

    expect(result).toEqual([[a, b]])
    expect(result[0]?.[0]).toBe(a)
  })

  it("joins a long chain into one component", () => {
    const keys = Array.from({ length: 500 }, (_, i) => `n${String(i).padStart(4, "0")}`)
    const edges = keys.slice(1).map((key, i): Edge => [keys[i] ?? "", key])

    expect(components(keys, edges)).toEqual([keys])
  })
})
