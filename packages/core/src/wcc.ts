/**
 * Weakly-connected components (WCC) via Union-Find with union-by-rank and
 * path compression. Language-independent primitive used by Slice View
 * (docs/design/slice-view.md §6) to group changed Symbols by call-graph
 * connectivity, but the algorithm is agnostic to what a "node" is — the
 * `keyOf` callback provides a stable string identity per node.
 *
 * Complexity: `O((V + E)·α(V))`, effectively linear.
 *
 * Guarantees (see slice-view.md §10):
 * - Deterministic: same `(nodes, edges)` always yields the same output.
 * - Input-order insensitive: shuffling `nodes` or `edges` yields the same
 *   output.
 * - Locality: adding a disjoint node/component elsewhere never permutes
 *   existing components.
 *
 * Edges are treated as undirected. Edges whose endpoints are not both in
 * `nodes` are silently dropped — the caller is responsible for building the
 * Node set (Slice View §5.2 forbids bridging via non-Node Symbols, which the
 * caller enforces by omitting non-Node endpoints from the input).
 */
export function computeWeaklyConnectedComponents<TNode>(
  nodes: readonly TNode[],
  edges: readonly [TNode, TNode][],
  keyOf: (node: TNode) => string,
): TNode[][] {
  if (nodes.length === 0) return []

  // Map keys → deterministic slot index, and slot index → original node.
  // `nodes[]` is iterated in its input order to pick the first-seen instance
  // per key so equal keys never fork the Union-Find into two roots (edges may
  // reference a different object instance for the same key — see the
  // "same key, different object" test).
  const indexByKey = new Map<string, number>()
  const nodesByIndex: TNode[] = []
  for (const node of nodes) {
    const key = keyOf(node)
    if (indexByKey.has(key)) continue
    indexByKey.set(key, nodesByIndex.length)
    nodesByIndex.push(node)
  }

  const n = nodesByIndex.length
  const parent = new Int32Array(n)
  const rank = new Int8Array(n)
  for (let i = 0; i < n; i++) parent[i] = i

  const find = (x: number): number => {
    let cur = x
    while (parent[cur] !== cur) {
      const grand = parent[parent[cur] as number] as number
      parent[cur] = grand
      cur = grand
    }
    return cur
  }

  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    const rankA = rank[ra] as number
    const rankB = rank[rb] as number
    if (rankA < rankB) parent[ra] = rb
    else if (rankA > rankB) parent[rb] = ra
    else {
      parent[rb] = ra
      rank[ra] = rankA + 1
    }
  }

  // Canonicalise every edge into (u, v) with u < v, keyed by index. Edges
  // referencing keys outside the node set are dropped. Self-loops (u === v)
  // are dropped — they add no cross-node connectivity. Multi-edges collapse
  // naturally because `union` is a no-op on already-merged roots.
  //
  // The final connected-component partition is a property of the graph and
  // does not depend on the order `union` sees the edges — Union-Find over
  // any permutation of a fixed edge set yields the same partition. Sorting
  // is a defence-in-depth choice: the internal parent-tree shape becomes a
  // function of the sorted stream, which keeps traces reproducible and
  // simplifies debugging without changing the visible output. Output
  // ordering is enforced separately by the `compareKey` sorts below.
  interface CanonEdge {
    lo: number
    hi: number
  }
  const canonEdges: CanonEdge[] = []
  for (const [aNode, bNode] of edges) {
    const aIdx = indexByKey.get(keyOf(aNode))
    const bIdx = indexByKey.get(keyOf(bNode))
    if (aIdx === undefined || bIdx === undefined) continue
    if (aIdx === bIdx) continue
    const lo = aIdx < bIdx ? aIdx : bIdx
    const hi = aIdx < bIdx ? bIdx : aIdx
    canonEdges.push({ lo, hi })
  }
  canonEdges.sort((x, y) => (x.lo !== y.lo ? x.lo - y.lo : x.hi - y.hi))
  for (const edge of canonEdges) union(edge.lo, edge.hi)

  // Bucket indices by their final root. Sorted iteration over index i =
  // 0..n-1 combined with `nodesByIndex` being built in the *first-seen*
  // order per key (also the sorted-input assumption below) gives us
  // deterministic within-component ordering after the sort step.
  const bucketsByRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const bucket = bucketsByRoot.get(root)
    if (bucket === undefined) bucketsByRoot.set(root, [i])
    else bucket.push(i)
  }

  const components: TNode[][] = []
  for (const bucket of bucketsByRoot.values()) {
    const sortedIndices = bucket
      .slice()
      .sort((a, b) => compareKey(keyOf(nodesByIndex[a] as TNode), keyOf(nodesByIndex[b] as TNode)))
    components.push(sortedIndices.map((idx) => nodesByIndex[idx] as TNode))
  }

  components.sort((a, b) => compareKey(keyOf(a[0] as TNode), keyOf(b[0] as TNode)))
  return components
}

function compareKey(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
