import type {
  Confidence,
  Effect,
  EffectPropagationStats,
  Symbol as IRSymbol,
  SymbolId,
} from "@aburi/types"
import type { CallEdge } from "./callgraph"
import { CoreError } from "./errors"

function invariantFailure(message: string): never {
  throw new CoreError(`propagate: ${message}`, { code: "propagation-invariant-violated" })
}

/**
 * Transitive effect propagation over the resolved call graph. Implements
 * docs/design/effect-propagation.md — SCC (Tarjan) → condensed DAG →
 * reverse-topological sweep → `(effectId, target)` set-union merge with
 * `min`-along-path / `max`-across-paths confidence combination.
 *
 * The pass is a pure function of `(symbols, edges)`. Local (plugin-classified)
 * effects survive verbatim in each Symbol's `effects[]` in original call order;
 * transitively-reachable effects are appended as `propagated: true` entries
 * sorted by `(effectId, target)` ascending, with `line` omitted and
 * `derivedFrom` recording the *direct* upstream callee(s) only.
 */
export interface PropagateInput {
  /** Symbols returned by `resolveCallGraph` (with `calls[].resolved` filled in). */
  symbols: readonly IRSymbol[]
  /** Resolved call edges. Iteration order does not affect the result. */
  edges: readonly CallEdge[]
}

export interface PropagateResult {
  symbols: IRSymbol[]
  stats: EffectPropagationStats
}

/**
 * Alias for `EffectPropagationStats` re-exported through the propagation module so
 * callers can import stats and pass alongside without also reaching into `@aburi/types`.
 */
export type PropagationStats = EffectPropagationStats

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b
}
function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b
}

function keyOf(effectId: string, target: string): string {
  return `${effectId}\t${target}`
}

interface AggregatedEntry {
  id: string
  target: string
  plugin: string
  confidence: Confidence
  derivedBy: string
  /** True when at least one SCC member has this (id, target) as a locally-detected effect. */
  hasLocal: boolean
}

interface SccNode {
  id: string
  members: SymbolId[]
  outSccs: number[]
  outEdgeConfidence: Map<number, Confidence>
}

export function propagateEffects(input: PropagateInput): PropagateResult {
  const symbolById = new Map<SymbolId, IRSymbol>()
  for (const s of input.symbols) symbolById.set(s.id, s)
  const nodeIds = [...symbolById.keys()].sort(compareCodeUnit)

  const adjacency = buildAdjacency(nodeIds, input.edges)
  const { sccs, sccOfNode } = tarjanSCC(nodeIds, adjacency)
  const condensed = condense(sccs, sccOfNode, adjacency)
  const sweepOrder = reverseTopoOrder(condensed)

  const aggregateBySccIdx: Map<string, AggregatedEntry>[] = condensed.map(() => new Map())

  for (const sccIdx of sweepOrder) {
    // sweepOrder is a permutation of condensed's indices — every entry MUST index
    // into both condensed and aggregateBySccIdx. A miss here would mean the DAG
    // reverse-topo order and the SCC list have desynchronized, and silently
    // skipping would swallow the whole SCC's effect set. Throw so upstream sees it.
    const scc = condensed[sccIdx] ?? invariantFailure(`sweepOrder references missing SCC ${sccIdx}`)
    const agg =
      aggregateBySccIdx[sccIdx] ?? invariantFailure(`aggregate slot missing for SCC ${sccIdx}`)

    for (const memberId of scc.members) {
      const symbol =
        symbolById.get(memberId) ??
        invariantFailure(`SCC member ${memberId} missing from symbolById`)
      for (const effect of symbol.effects) {
        if (effect.propagated === true) continue
        const k = keyOf(effect.id, effect.target)
        const existing = agg.get(k)
        if (existing === undefined) {
          agg.set(k, {
            id: effect.id,
            target: effect.target,
            plugin: effect.plugin,
            confidence: effect.confidence,
            derivedBy: effect.derivedBy,
            hasLocal: true,
          })
        } else {
          existing.hasLocal = true
          existing.confidence = maxConfidence(existing.confidence, effect.confidence)
          if (effect.derivedBy < existing.derivedBy) {
            existing.derivedBy = effect.derivedBy
            existing.plugin = effect.plugin
          }
        }
      }
    }

    for (const toScc of scc.outSccs) {
      const edgeConfidence =
        scc.outEdgeConfidence.get(toScc) ??
        invariantFailure(`outSccs entry ${toScc} missing edge-confidence for SCC ${sccIdx}`)
      const downstream =
        aggregateBySccIdx[toScc] ??
        invariantFailure(`downstream aggregate missing for SCC ${toScc}`)
      for (const downEntry of downstream.values()) {
        const propagatedConfidence = minConfidence(downEntry.confidence, edgeConfidence)
        const k = keyOf(downEntry.id, downEntry.target)
        const existing = agg.get(k)
        if (existing === undefined) {
          agg.set(k, {
            id: downEntry.id,
            target: downEntry.target,
            plugin: downEntry.plugin,
            confidence: propagatedConfidence,
            derivedBy: downEntry.derivedBy,
            hasLocal: false,
          })
          continue
        }
        existing.confidence = maxConfidence(existing.confidence, propagatedConfidence)
        // Keep `plugin` and `derivedBy` in lock-step. When a local classification is
        // already present anywhere in the SCC the local's (plugin, derivedBy) pair
        // wins verbatim per effect-propagation.md §5.1 — downstream cannot rename
        // either field. When there is no local, the downstream contribution with
        // the lexicographically smallest `derivedBy` wins (§5.2) and BOTH fields
        // move together so a reader never sees "plugin says X, derivedBy says Y".
        if (!existing.hasLocal && downEntry.derivedBy < existing.derivedBy) {
          existing.derivedBy = downEntry.derivedBy
          existing.plugin = downEntry.plugin
        }
      }
    }
  }

  const localKeysBySymbol = new Map<SymbolId, Set<string>>()
  for (const symbol of input.symbols) {
    const set = new Set<string>()
    for (const effect of symbol.effects) {
      if (effect.propagated === true) continue
      set.add(keyOf(effect.id, effect.target))
    }
    localKeysBySymbol.set(symbol.id, set)
  }

  const nextSymbols: IRSymbol[] = []
  let propagatedEffectCount = 0
  let symbolsWithPropagatedEffects = 0

  for (const original of input.symbols) {
    const localEffects = original.effects.filter((e) => e.propagated !== true)
    const localKeys = localKeysBySymbol.get(original.id) ?? new Set()
    const mySccIdx = sccOfNode.get(original.id)
    const mySccAgg = mySccIdx !== undefined ? aggregateBySccIdx[mySccIdx] : undefined
    const outCallees = (adjacency.get(original.id) ?? []).map((n) => n.to)

    const propagatedEntries: Effect[] = []
    if (mySccAgg !== undefined) {
      for (const entry of mySccAgg.values()) {
        if (localKeys.has(keyOf(entry.id, entry.target))) continue
        const k = keyOf(entry.id, entry.target)
        const derivedFromSet = new Set<SymbolId>()
        for (const callee of outCallees) {
          // callee came from `adjacency.get(original.id)`, which only contains
          // nodes present in the input; sccOfNode was populated for every one.
          // A miss means the SCC book-keeping is inconsistent.
          const calleeSccIdx =
            sccOfNode.get(callee) ??
            invariantFailure(`out-callee ${callee} of ${original.id} has no SCC`)
          const calleeAgg =
            aggregateBySccIdx[calleeSccIdx] ??
            invariantFailure(`aggregate missing for callee SCC ${calleeSccIdx}`)
          if (calleeAgg.has(k)) derivedFromSet.add(callee)
        }
        if (derivedFromSet.size === 0) continue
        const derivedFrom = [...derivedFromSet].sort(compareCodeUnit)
        propagatedEntries.push({
          id: entry.id,
          target: entry.target,
          plugin: entry.plugin,
          confidence: entry.confidence,
          derivedBy: entry.derivedBy,
          propagated: true,
          derivedFrom,
        })
      }
    }
    propagatedEntries.sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1
      return a.target < b.target ? -1 : a.target > b.target ? 1 : 0
    })

    if (propagatedEntries.length > 0) {
      symbolsWithPropagatedEffects += 1
      propagatedEffectCount += propagatedEntries.length
    }

    const nextEffects: Effect[] = [...localEffects, ...propagatedEntries]
    nextSymbols.push({ ...original, effects: nextEffects })
  }

  const maxSccSize = condensed.reduce((max, scc) => Math.max(max, scc.members.length), 0)
  return {
    symbols: nextSymbols,
    stats: {
      sccCount: condensed.length,
      maxSccSize,
      propagatedEffectCount,
      symbolsWithPropagatedEffects,
    },
  }
}

function buildAdjacency(
  nodeIds: readonly SymbolId[],
  edges: readonly CallEdge[],
): Map<SymbolId, Array<{ to: SymbolId; confidence: Confidence }>> {
  const adj = new Map<SymbolId, Array<{ to: SymbolId; confidence: Confidence }>>()
  for (const id of nodeIds) adj.set(id, [])
  const seen = new Map<string, Confidence>()
  for (const e of edges) {
    // Every CallEdge must reference Symbols in the input set — resolveCallGraph
    // filters against `keptSymbolIds`. A dangling endpoint here means the caller
    // passed a `symbols`/`edges` pair that disagrees, and silently dropping the
    // edge would hide propagation from every path that transits it.
    if (!adj.has(e.from)) {
      invariantFailure(`CallEdge.from ${e.from} is not present in input symbols`)
    }
    if (!adj.has(e.to)) {
      invariantFailure(`CallEdge.to ${e.to} is not present in input symbols`)
    }
    const key = `${e.from}\t${e.to}`
    const prior = seen.get(key)
    seen.set(key, prior === undefined ? e.confidence : maxConfidence(prior, e.confidence))
  }
  for (const [key, confidence] of seen) {
    const tab = key.indexOf("\t")
    const from = key.slice(0, tab) as SymbolId
    const to = key.slice(tab + 1) as SymbolId
    const bucket = adj.get(from)
    if (bucket !== undefined) bucket.push({ to, confidence })
  }
  for (const bucket of adj.values()) {
    bucket.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
  }
  return adj
}

interface SccResult {
  sccs: SymbolId[][]
  sccOfNode: Map<SymbolId, number>
}

function tarjanSCC(
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
            // Tarjan's contract: the stack must contain at least frame.node when
            // we detect a root (idx === low), so this can only trigger if the
            // recursion has a bug. Convert the silent `as SymbolId` cast into an
            // observable failure so a future refactor cannot loop forever here.
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

function condense(
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

function reverseTopoOrder(condensed: readonly SccNode[]): number[] {
  const remainingOut = condensed.map((n) => n.outSccs.length)
  const reverseAdj: number[][] = condensed.map(() => [])
  condensed.forEach((node, idx) => {
    for (const toScc of node.outSccs) reverseAdj[toScc]?.push(idx)
  })
  const queue: number[] = []
  condensed.forEach((_, idx) => {
    if (remainingOut[idx] === 0) queue.push(idx)
  })
  queue.sort((a, b) => a - b)
  const order: number[] = []
  while (queue.length > 0) {
    queue.sort((a, b) => a - b)
    const next = queue.shift() as number
    order.push(next)
    for (const upstream of reverseAdj[next] ?? []) {
      const rem = remainingOut[upstream]
      if (rem === undefined) continue
      remainingOut[upstream] = rem - 1
      if (remainingOut[upstream] === 0) queue.push(upstream)
    }
  }
  return order
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
