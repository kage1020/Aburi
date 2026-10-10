import { compareCodeUnit } from "@aburi/core"
import type { Symbol as IRSymbol, MatchRationale, SymbolId } from "@aburi/types"
import { nameEvidence } from "../similarity"

export interface SymbolPair {
  base: IRSymbol
  head: IRSymbol
  rationale: MatchRationale
}

export interface StageResult {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
}

export interface Endpoints {
  base: IRSymbol
  head: IRSymbol
}

export interface ScoredPair extends Endpoints {
  score: number
}

interface Assignment {
  pairs: readonly ScoredPair[]
  baseIds: ReadonlySet<SymbolId>
  headIds: ReadonlySet<SymbolId>
}

export function acceptInScoreOrder(candidates: ScoredPair[]): Assignment {
  candidates.sort(compareCandidates)
  const baseIds = new Set<SymbolId>()
  const headIds = new Set<SymbolId>()
  const pairs: ScoredPair[] = []
  for (const candidate of candidates) {
    if (baseIds.has(candidate.base.id) || headIds.has(candidate.head.id)) continue
    baseIds.add(candidate.base.id)
    headIds.add(candidate.head.id)
    pairs.push(candidate)
  }
  return { pairs, baseIds, headIds }
}

function compareCandidates(a: ScoredPair, b: ScoredPair): number {
  return b.score - a.score || compareByEndpoints(a, b)
}

export function compareByEndpoints(a: Endpoints, b: Endpoints): number {
  return compareCodeUnit(a.base.id, b.base.id) || compareCodeUnit(a.head.id, b.head.id)
}

export function unclaimed(
  symbols: readonly IRSymbol[],
  claimed: ReadonlySet<SymbolId>,
): IRSymbol[] {
  return symbols.filter((symbol) => !claimed.has(symbol.id))
}

export function stageResult(
  matched: SymbolPair[],
  base: readonly IRSymbol[],
  head: readonly IRSymbol[],
): StageResult {
  return {
    matched,
    remainingBase: unclaimed(base, new Set(matched.map((pair) => pair.base.id))),
    remainingHead: unclaimed(head, new Set(matched.map((pair) => pair.head.id))),
  }
}

export function saysEnoughToPair(qname: string): boolean {
  return nameEvidence(qname) > 1
}
