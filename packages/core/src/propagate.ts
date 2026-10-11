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
  confidence: Confidence
  derivedBy: string
  hasLocal: boolean
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
    const scc = condensed[sccIdx] ?? invariantFailure(`sweepOrder references missing SCC ${sccIdx}`)
    const agg =
      aggregateBySccIdx[sccIdx] ?? invariantFailure(`aggregate slot missing for SCC ${sccIdx}`)

    for (const memberId of scc.members) {
      const symbol =
        symbolById.get(memberId) ??
        invariantFailure(`SCC member ${memberId} missing from symbolById`)
      for (const effect of symbol.effects) {
        if (effect.propagated === true) continue
        const key = effectKey(effect.id, effect.target)
        const existing = agg.get(key)
        if (existing === undefined) {
          agg.set(key, {
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
        const key = effectKey(downEntry.id, downEntry.target)
        const existing = agg.get(key)
        if (existing === undefined) {
          agg.set(key, {
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
          confidence: entry.confidence,
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
