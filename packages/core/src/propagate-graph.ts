import type { Confidence, SymbolId } from "@aburi/types"
import { callEdgeKey } from "./call-site"
import type { CallEdge } from "./callgraph"
import { CoreError } from "./errors"
import { compareBy, compareCodeUnit } from "./order"

export function invariantFailure(message: string): never {
  throw new CoreError(`propagate: ${message}`, { code: "propagation-invariant-violated" })
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b
}
export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b
}

export interface SccNode {
  id: string
  members: SymbolId[]
  outSccs: number[]
  outEdgeConfidence: Map<number, Confidence>
}

export function buildAdjacency(
  nodeIds: readonly SymbolId[],
  edges: readonly CallEdge[],
): Map<SymbolId, Array<{ to: SymbolId; confidence: Confidence }>> {
  const adj = new Map<SymbolId, Array<{ to: SymbolId; confidence: Confidence }>>()
  for (const id of nodeIds) adj.set(id, [])
  const seen = new Map<string, { from: SymbolId; to: SymbolId; confidence: Confidence }>()
  for (const edge of edges) {
    if (!adj.has(edge.from)) {
      invariantFailure(`CallEdge.from ${edge.from} is not present in input symbols`)
    }
    if (!adj.has(edge.to)) {
      invariantFailure(`CallEdge.to ${edge.to} is not present in input symbols`)
    }
    const key = callEdgeKey(edge.from, edge.to)
    const prior = seen.get(key)
    seen.set(key, {
      from: edge.from,
      to: edge.to,
      confidence:
        prior === undefined ? edge.confidence : maxConfidence(prior.confidence, edge.confidence),
    })
  }
  for (const { from, to, confidence } of seen.values()) {
    const bucket = adj.get(from)
    if (bucket !== undefined) bucket.push({ to, confidence })
  }
  for (const bucket of adj.values()) bucket.sort(compareBy((edge) => edge.to))
  return adj
}

interface SccResult {
  sccs: SymbolId[][]
  sccOfNode: Map<SymbolId, number>
}

export function tarjanSCC(
  nodeIds: readonly SymbolId[],
  adj: Map<SymbolId, Array<{ to: SymbolId }>>,
): SccResult {
  const index = new Map<SymbolId, number>()
  const lowLink = new Map<SymbolId, number>()
  const onStack = new Set<SymbolId>()
  const stack: SymbolId[] = []
  let nextIndex = 0
  const sccs: SymbolId[][] = []

  interface Frame {
    node: SymbolId
    children: Array<{ to: SymbolId }>
    cursor: number
    lastChild: SymbolId | null
  }

  const pushFrame = (workStack: Frame[], node: SymbolId): void => {
    index.set(node, nextIndex)
    lowLink.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)
    const children = adj.get(node) ?? []
    workStack.push({ node, children: [...children], cursor: 0, lastChild: null })
  }

  for (const start of nodeIds) {
    if (index.has(start)) continue
    const workStack: Frame[] = []
    pushFrame(workStack, start)
    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1] as Frame
      if (frame.lastChild !== null) {
        const childLow = lowLink.get(frame.lastChild)
        const currentLow = lowLink.get(frame.node)
        if (childLow !== undefined && currentLow !== undefined) {
          lowLink.set(frame.node, Math.min(currentLow, childLow))
        }
        frame.lastChild = null
      }
      if (frame.cursor >= frame.children.length) {
        const idx = index.get(frame.node)
        const low = lowLink.get(frame.node)
        if (idx !== undefined && low !== undefined && idx === low) {
          const component: SymbolId[] = []
          while (true) {
            const popped = stack.pop()
            if (popped === undefined) {
              invariantFailure(`SCC stack drained before reaching root ${frame.node}`)
            }
            onStack.delete(popped)
            component.push(popped)
            if (popped === frame.node) break
          }
          component.sort(compareCodeUnit)
          sccs.push(component)
        }
        workStack.pop()
        continue
      }
      const child = frame.children[frame.cursor]?.to
      frame.cursor += 1
      if (child === undefined) continue
      if (!index.has(child)) {
        frame.lastChild = child
        pushFrame(workStack, child)
      } else if (onStack.has(child)) {
        const currentLow = lowLink.get(frame.node)
        const childIdx = index.get(child)
        if (currentLow !== undefined && childIdx !== undefined) {
          lowLink.set(frame.node, Math.min(currentLow, childIdx))
        }
      }
    }
  }

  sccs.sort((a, b) => compareCodeUnit(a[0] ?? "", b[0] ?? ""))
  const sccOfNode = new Map<SymbolId, number>()
  sccs.forEach((component, i) => {
    for (const node of component) sccOfNode.set(node, i)
  })
  return { sccs, sccOfNode }
}

export function condense(
  sccs: readonly SymbolId[][],
  sccOfNode: ReadonlyMap<SymbolId, number>,
  adj: ReadonlyMap<SymbolId, ReadonlyArray<{ to: SymbolId; confidence: Confidence }>>,
): SccNode[] {
  const nodes: SccNode[] = sccs.map((members, i) => ({
    id: members[0] ?? String(i),
    members: [...members],
    outSccs: [],
    outEdgeConfidence: new Map(),
  }))
  for (const [from, neighbours] of adj) {
    const fromSccIdx = sccOfNode.get(from)
    if (fromSccIdx === undefined) continue
    const fromScc = nodes[fromSccIdx]
    if (fromScc === undefined) continue
    for (const { to, confidence } of neighbours) {
      const toSccIdx = sccOfNode.get(to)
      if (toSccIdx === undefined || toSccIdx === fromSccIdx) continue
      const prior = fromScc.outEdgeConfidence.get(toSccIdx)
      fromScc.outEdgeConfidence.set(
        toSccIdx,
        prior === undefined ? confidence : maxConfidence(prior, confidence),
      )
    }
  }
  for (const node of nodes) {
    node.outSccs = [...node.outEdgeConfidence.keys()].sort((a, b) => a - b)
  }
  return nodes
}

export function reverseTopoOrder(condensed: readonly SccNode[]): number[] {
  const remainingOut = condensed.map((scc) => scc.outSccs.length)
  const reverseAdj: number[][] = condensed.map(() => [])
  condensed.forEach((node, idx) => {
    for (const toScc of node.outSccs) reverseAdj[toScc]?.push(idx)
  })

  const ready = new MinHeap()
  condensed.forEach((_, idx) => {
    if (remainingOut[idx] === 0) ready.push(idx)
  })

  const order: number[] = []
  for (let next = ready.pop(); next !== undefined; next = ready.pop()) {
    order.push(next)
    for (const upstream of reverseAdj[next] ?? []) {
      const rem = remainingOut[upstream]
      if (rem === undefined) continue
      remainingOut[upstream] = rem - 1
      if (remainingOut[upstream] === 0) ready.push(upstream)
    }
  }
  return order
}

class MinHeap {
  private readonly items: number[] = []

  push(value: number): void {
    const items = this.items
    items.push(value)
    let child = items.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if ((items[parent] as number) <= (items[child] as number)) break
      ;[items[parent], items[child]] = [items[child] as number, items[parent] as number]
      child = parent
    }
  }

  pop(): number | undefined {
    const items = this.items
    const top = items[0]
    if (top === undefined) return undefined
    const last = items.pop() as number
    if (items.length === 0) return top
    items[0] = last
    let parent = 0
    for (;;) {
      const left = parent * 2 + 1
      const right = left + 1
      let smallest = parent
      if (left < items.length && (items[left] as number) < (items[smallest] as number)) {
        smallest = left
      }
      if (right < items.length && (items[right] as number) < (items[smallest] as number)) {
        smallest = right
      }
      if (smallest === parent) break
      ;[items[parent], items[smallest]] = [items[smallest] as number, items[parent] as number]
      parent = smallest
    }
    return top
  }
}
