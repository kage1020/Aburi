import { compareCodeUnit } from "./order"

export function computeWeaklyConnectedComponents<TNode>(
  nodes: readonly TNode[],
  edges: readonly [TNode, TNode][],
  keyOf: (node: TNode) => string,
): TNode[][] {
  if (nodes.length === 0) return []

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
      .sort((a, b) =>
        compareCodeUnit(keyOf(nodesByIndex[a] as TNode), keyOf(nodesByIndex[b] as TNode)),
      )
    components.push(sortedIndices.map((idx) => nodesByIndex[idx] as TNode))
  }

  components.sort((a, b) => compareCodeUnit(keyOf(a[0] as TNode), keyOf(b[0] as TNode)))
  return components
}
