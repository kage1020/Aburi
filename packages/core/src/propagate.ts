import type {
  Confidence,
  Effect,
  EffectPropagationStats,
  Symbol as IRSymbol,
  SymbolId,
} from "@aburi/types"
import type { CallEdge } from "./callgraph"
import { compareCodeUnit } from "./order"
import {
  buildAdjacency,
  callersWithinScc,
  condense,
  invariantFailure,
  maxConfidence,
  minConfidence,
  reverseTopoOrder,
  tarjanSCC,
} from "./propagate-graph"

export interface PropagateInput {
  symbols: readonly IRSymbol[]
  edges: readonly CallEdge[]
}

export interface PropagateResult {
  symbols: IRSymbol[]
  stats: EffectPropagationStats
}

export type PropagationStats = EffectPropagationStats

function effectKey(effectId: string, target: string): string {
  return `${effectId}\t${target}`
}

interface AggregatedEntry {
  id: string
  target: string
  plugin: string
  derivedBy: string
  hasLocal: boolean
}

type ConfidenceByKey = Map<string, Confidence>

function raise(reached: ConfidenceByKey, key: string, offered: Confidence): boolean {
  const held = reached.get(key)
  if (held !== undefined && maxConfidence(held, offered) === held) return false
  reached.set(key, offered)
  return true
}

/** A confidence only rises, through three levels, so each (member, key) is queued at most thrice. */
function settleWithinScc(
  members: readonly SymbolId[],
  callersInScc: ReadonlyMap<SymbolId, ReadonlyArray<{ from: SymbolId; confidence: Confidence }>>,
  confidenceByNode: ReadonlyMap<SymbolId, ConfidenceByKey>,
): void {
  const reachedOf = (id: SymbolId): ConfidenceByKey =>
    confidenceByNode.get(id) ?? invariantFailure(`SCC member ${id} has no confidence yet`)
  const pending: Array<{ callee: SymbolId; key: string }> = []
  for (const member of members) {
    for (const key of reachedOf(member).keys()) pending.push({ callee: member, key })
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { callee, key } = next
    const carried =
      reachedOf(callee).get(key) ?? invariantFailure(`${callee} lost its confidence for ${key}`)
    for (const { from, confidence } of callersInScc.get(callee) ?? []) {
      if (raise(reachedOf(from), key, minConfidence(confidence, carried))) {
        pending.push({ callee: from, key })
      }
    }
  }
}

export function propagateEffects(input: PropagateInput): PropagateResult {
  const symbolById = new Map<SymbolId, IRSymbol>()
  for (const s of input.symbols) symbolById.set(s.id, s)
  const nodeIds = [...symbolById.keys()].sort(compareCodeUnit)

  const adjacency = buildAdjacency(nodeIds, input.edges)
  const { sccs, sccOfNode } = tarjanSCC(nodeIds, adjacency)
  const condensed = condense(sccs, sccOfNode, adjacency)
  const sweepOrder = reverseTopoOrder(condensed)
  const callersInScc = callersWithinScc(adjacency, sccOfNode)

  const aggregateBySccIdx: Map<string, AggregatedEntry>[] = condensed.map(() => new Map())
  const confidenceByNode = new Map<SymbolId, ConfidenceByKey>()

  for (const sccIdx of sweepOrder) {
    const scc = condensed[sccIdx] ?? invariantFailure(`sweepOrder references missing SCC ${sccIdx}`)
    const agg =
      aggregateBySccIdx[sccIdx] ?? invariantFailure(`aggregate slot missing for SCC ${sccIdx}`)

    for (const memberId of scc.members) {
      const symbol =
        symbolById.get(memberId) ??
        invariantFailure(`SCC member ${memberId} missing from symbolById`)
      const reached: ConfidenceByKey = new Map()
      for (const effect of symbol.effects) {
        if (effect.propagated === true) continue
        const key = effectKey(effect.id, effect.target)
        raise(reached, key, effect.confidence)
        const existing = agg.get(key)
        if (existing === undefined) {
          agg.set(key, {
            id: effect.id,
            target: effect.target,
            plugin: effect.plugin,
            derivedBy: effect.derivedBy,
            hasLocal: true,
          })
        } else {
          existing.hasLocal = true
          if (effect.derivedBy < existing.derivedBy) {
            existing.derivedBy = effect.derivedBy
            existing.plugin = effect.plugin
          }
        }
      }
      for (const { to, confidence } of adjacency.get(memberId) ?? []) {
        if (sccOfNode.get(to) === sccIdx) continue
        const carried =
          confidenceByNode.get(to) ??
          invariantFailure(`callee ${to} of ${memberId} swept after its caller`)
        for (const [key, calleeConfidence] of carried) {
          raise(reached, key, minConfidence(confidence, calleeConfidence))
        }
      }
      confidenceByNode.set(memberId, reached)
    }
    if (scc.members.length > 1) settleWithinScc(scc.members, callersInScc, confidenceByNode)

    for (const toScc of scc.outSccs) {
      const downstream =
        aggregateBySccIdx[toScc] ??
        invariantFailure(`downstream aggregate missing for SCC ${toScc}`)
      for (const downEntry of downstream.values()) {
        const key = effectKey(downEntry.id, downEntry.target)
        const existing = agg.get(key)
        if (existing === undefined) {
          agg.set(key, {
            id: downEntry.id,
            target: downEntry.target,
            plugin: downEntry.plugin,
            derivedBy: downEntry.derivedBy,
            hasLocal: false,
          })
          continue
        }
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
      set.add(effectKey(effect.id, effect.target))
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
    const reached =
      confidenceByNode.get(original.id) ?? invariantFailure(`symbol ${original.id} was never swept`)
    const outCallees = (adjacency.get(original.id) ?? []).map((edge) => edge.to)

    const propagatedEntries: Effect[] = []
    if (mySccAgg !== undefined) {
      for (const entry of mySccAgg.values()) {
        const key = effectKey(entry.id, entry.target)
        if (localKeys.has(key)) continue
        const derivedFromSet = new Set<SymbolId>()
        for (const callee of outCallees) {
          const calleeSccIdx =
            sccOfNode.get(callee) ??
            invariantFailure(`out-callee ${callee} of ${original.id} has no SCC`)
          const calleeAgg =
            aggregateBySccIdx[calleeSccIdx] ??
            invariantFailure(`aggregate missing for callee SCC ${calleeSccIdx}`)
          if (calleeAgg.has(key)) derivedFromSet.add(callee)
        }
        if (derivedFromSet.size === 0) continue
        const derivedFrom = [...derivedFromSet].sort(compareCodeUnit)
        propagatedEntries.push({
          id: entry.id,
          target: entry.target,
          plugin: entry.plugin,
          confidence:
            reached.get(key) ?? invariantFailure(`${original.id} reached ${key} at no confidence`),
          derivedBy: entry.derivedBy,
          propagated: true,
          derivedFrom,
        })
      }
    }
    propagatedEntries.sort(
      (a, b) => compareCodeUnit(a.id, b.id) || compareCodeUnit(a.target, b.target),
    )

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
