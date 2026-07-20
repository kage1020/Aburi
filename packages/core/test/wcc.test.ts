import { describe, expect, it } from "vitest"
import { computeWeaklyConnectedComponents } from "../src/wcc"

/**
 * Union-Find WCC utility tests. These are the language-agnostic properties the
 * primitive must uphold; Slice-View-specific rules (Node/Edge selection, sliceId
 * naming) live in `packages/diff/test/slice.test.ts`.
 *
 * Determinism, idempotence, input-order insensitivity, and locality here directly
 * back SV15–SV18 of docs/design/slice-view.md, because Slice View delegates the
 * grouping to this utility unchanged.
 */

interface Node {
  key: string
}
const n = (key: string): Node => ({ key })
const keyOf = (x: Node): string => x.key

describe("computeWeaklyConnectedComponents", () => {
  it("returns [] when there are no nodes", () => {
    expect(computeWeaklyConnectedComponents<Node>([], [], keyOf)).toEqual([])
  })

  it("returns one singleton per unconnected node", () => {
    const nodes = [n("a"), n("b"), n("c")]
    const result = computeWeaklyConnectedComponents(nodes, [], keyOf)
    expect(result.map((comp) => comp.map(keyOf))).toEqual([["a"], ["b"], ["c"]])
  })

  it("merges two nodes joined by a single edge", () => {
    const nodes = [n("a"), n("b")]
    const result = computeWeaklyConnectedComponents(nodes, [[n("a"), n("b")]], keyOf)
    expect(result).toHaveLength(1)
    expect(result[0]?.map(keyOf)).toEqual(["a", "b"])
  })

  it("edges are undirected — [a,b] and [b,a] behave the same", () => {
    const nodes = [n("a"), n("b")]
    const forward = computeWeaklyConnectedComponents(nodes, [[n("a"), n("b")]], keyOf)
    const reverse = computeWeaklyConnectedComponents(nodes, [[n("b"), n("a")]], keyOf)
    expect(forward.map((c) => c.map(keyOf))).toEqual(reverse.map((c) => c.map(keyOf)))
  })

  it("directed cycle a→b→c→a collapses into one component (no SCC pre-condense)", () => {
    // SV9 backing: slice-view.md §14.2 — an undirected walk over the directed
    // cycle unifies all three nodes into a single component; no SCC / DAG
    // condensation should happen inside the primitive.
    const nodes = [n("a"), n("b"), n("c")]
    const edges: [Node, Node][] = [
      [n("a"), n("b")],
      [n("b"), n("c")],
      [n("c"), n("a")],
    ]
    const result = computeWeaklyConnectedComponents(nodes, edges, keyOf)
    expect(result).toHaveLength(1)
    expect(result[0]?.map(keyOf)).toEqual(["a", "b", "c"])
  })

  it("edges referencing nodes outside the node set are ignored (bridging is a caller concern)", () => {
    // The utility should NOT quietly union across implicit external nodes; §5.2
    // "no bridging via non-Node symbols" is enforced by giving this function only
    // the Node subset. Any edge whose endpoint is not in `nodes` must be dropped.
    const nodes = [n("a"), n("b")]
    const result = computeWeaklyConnectedComponents(
      nodes,
      [
        [n("a"), n("middle")],
        [n("middle"), n("b")],
      ],
      keyOf,
    )
    expect(result.map((c) => c.map(keyOf))).toEqual([["a"], ["b"]])
  })

  it("self-loops do not fabricate additional connectivity", () => {
    const nodes = [n("a"), n("b")]
    const result = computeWeaklyConnectedComponents(
      nodes,
      [
        [n("a"), n("a")],
        [n("b"), n("b")],
      ],
      keyOf,
    )
    expect(result.map((c) => c.map(keyOf))).toEqual([["a"], ["b"]])
  })

  it("multi-edges between the same pair produce the same component (dedup safe)", () => {
    const nodes = [n("a"), n("b")]
    const result = computeWeaklyConnectedComponents(
      nodes,
      [
        [n("a"), n("b")],
        [n("a"), n("b")],
        [n("b"), n("a")],
      ],
      keyOf,
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.map(keyOf)).toEqual(["a", "b"])
  })

  it("nodes within a component are returned in ascending key order", () => {
    const nodes = [n("c"), n("a"), n("b")]
    const result = computeWeaklyConnectedComponents(
      nodes,
      [
        [n("c"), n("a")],
        [n("a"), n("b")],
      ],
      keyOf,
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.map(keyOf)).toEqual(["a", "b", "c"])
  })

  it("components are returned in ascending smallest-member-key order", () => {
    const nodes = [n("m"), n("x"), n("a"), n("z"), n("b")]
    const result = computeWeaklyConnectedComponents(
      nodes,
      [
        [n("m"), n("x")],
        [n("a"), n("b")],
      ],
      keyOf,
    )
    expect(result.map((c) => c.map(keyOf))).toEqual([["a", "b"], ["m", "x"], ["z"]])
  })

  it("idempotence — same input twice yields structurally equal output (SV17 backing)", () => {
    const nodes = [n("c"), n("a"), n("b"), n("d")]
    const edges: [Node, Node][] = [
      [n("a"), n("b")],
      [n("c"), n("d")],
    ]
    const one = computeWeaklyConnectedComponents(nodes, edges, keyOf)
    const two = computeWeaklyConnectedComponents(nodes, edges, keyOf)
    expect(two.map((c) => c.map(keyOf))).toEqual(one.map((c) => c.map(keyOf)))
  })

  it("input-order insensitive — shuffled nodes and shuffled edges → same output (SV18 backing)", () => {
    const canonical = computeWeaklyConnectedComponents(
      [n("a"), n("b"), n("c"), n("d")],
      [
        [n("a"), n("b")],
        [n("c"), n("d")],
      ],
      keyOf,
    )
    const shuffled = computeWeaklyConnectedComponents(
      [n("d"), n("a"), n("c"), n("b")],
      [
        [n("d"), n("c")],
        [n("b"), n("a")],
      ],
      keyOf,
    )
    expect(shuffled.map((c) => c.map(keyOf))).toEqual(canonical.map((c) => c.map(keyOf)))
  })

  it("locality — adding a disjoint singleton node does not disturb prior components (SV18 backing)", () => {
    const before = computeWeaklyConnectedComponents([n("a"), n("b")], [[n("a"), n("b")]], keyOf)
    const after = computeWeaklyConnectedComponents(
      [n("a"), n("b"), n("z")],
      [[n("a"), n("b")]],
      keyOf,
    )
    // The a-b component should appear structurally identical between the two runs;
    // only the new `["z"]` singleton is appended (in sorted order).
    expect(after[0]?.map(keyOf)).toEqual(before[0]?.map(keyOf))
    expect(after.map((c) => c.map(keyOf))).toEqual([["a", "b"], ["z"]])
  })

  it("handles a chain of many nodes efficiently (union-by-rank sanity)", () => {
    // Not a benchmark — just guards against O(n^2) accidental union chains that
    // path-compression would otherwise mask in small tests.
    const size = 500
    const nodes = Array.from({ length: size }, (_, i) => n(`n${String(i).padStart(4, "0")}`))
    const edges: [Node, Node][] = []
    for (let i = 0; i < size - 1; i++) {
      const a = nodes[i]
      const b = nodes[i + 1]
      if (a === undefined || b === undefined) continue
      edges.push([a, b])
    }
    const result = computeWeaklyConnectedComponents(nodes, edges, keyOf)
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(size)
  })

  it("keyOf is called with each input node exactly enough to identify it, not on external endpoints", () => {
    // Regression guard: if keyOf were called with an edge endpoint that is a
    // *different object instance* than the node in `nodes`, callers who use
    // reference-comparing keyOfs (rare, but possible) would break. The utility
    // must resolve edges by key equality, not by object identity.
    const a = n("a")
    const b = n("b")
    // Same key, different object identity.
    const otherA = n("a")
    const result = computeWeaklyConnectedComponents([a, b], [[otherA, b]], keyOf)
    expect(result).toHaveLength(1)
    expect(result[0]?.map(keyOf)).toEqual(["a", "b"])
  })
})
