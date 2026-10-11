import { logicNamesNothing, ZERO_FINGERPRINT } from "@aburi/core"
import type { Symbol as IRSymbol } from "@aburi/types"
import { createNameScorer, type NameScorer } from "../similarity"
import {
  acceptInScoreOrder,
  type ScoredPair,
  type StageResult,
  type SymbolPair,
  saysEnoughToPair,
  stageResult,
  unclaimed,
} from "./pairing"

const NAME_DISAMBIGUATION_THRESHOLD = 0.85

export function matchStageLogicFingerprint(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): StageResult {
  const baseGroups = groupByLogic(remainingBase)
  const headGroups = groupByLogic(remainingHead)
  const scorer = createNameScorer()
  const matched: SymbolPair[] = []
  for (const [key, heads] of headGroups) {
    const bases = baseGroups.get(key)
    if (bases === undefined) continue
    matched.push(...pairWithinLogicGroup(bases.symbols, heads.symbols, scorer, heads.evidenceless))
  }
  return stageResult(matched, remainingBase, remainingHead)
}

interface LogicGroup {
  evidenceless: boolean
  symbols: IRSymbol[]
}

function groupByLogic(symbols: readonly IRSymbol[]): Map<string, LogicGroup> {
  const groups = new Map<string, LogicGroup>()
  for (const symbol of symbols) {
    if (symbol.dropped || symbol.fingerprint.logic === ZERO_FINGERPRINT) continue
    const evidenceless = logicNamesNothing(symbol)
    const key = JSON.stringify([symbol.kind, symbol.fingerprint.logic, evidenceless])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { evidenceless, symbols: [symbol] })
    else group.symbols.push(symbol)
  }
  return groups
}

function pairWithinLogicGroup(
  bases: readonly IRSymbol[],
  heads: readonly IRSymbol[],
  scorer: NameScorer,
  evidenceless: boolean,
): SymbolPair[] {
  const admissible = (symbol: IRSymbol) => !evidenceless || saysEnoughToPair(symbol.name)
  let freeBase = bases.filter(admissible)
  let freeHead = heads.filter(admissible)
  const matched: SymbolPair[] = []
  while (freeBase.length > 0 && freeHead.length > 0) {
    const lone = !evidenceless && freeBase.length === 1 ? freeBase[0] : undefined
    if (lone !== undefined) {
      const head = closestNameTo(lone, freeHead, scorer)
      if (head === undefined) break
      matched.push({ base: lone, head, rationale: "logic-fingerprint" })
      break
    }
    const candidates: ScoredPair[] = []
    for (const base of freeBase) {
      for (const head of freeHead) {
        const score = scorer.name(base.name, head.name)
        if (score >= NAME_DISAMBIGUATION_THRESHOLD) candidates.push({ base, head, score })
      }
    }
    const accepted = acceptInScoreOrder(candidates)
    if (accepted.pairs.length === 0) break
    for (const { base, head } of accepted.pairs) {
      matched.push({ base, head, rationale: "logic-fingerprint+name-disambiguation" })
    }
    freeBase = unclaimed(freeBase, accepted.baseIds)
    freeHead = unclaimed(freeHead, accepted.headIds)
  }
  return matched
}

function closestNameTo(
  base: IRSymbol,
  heads: readonly IRSymbol[],
  scorer: NameScorer,
): IRSymbol | undefined {
  let best: { head: IRSymbol; score: number } | undefined
  for (const head of heads) {
    const score = scorer.name(base.name, head.name)
    if (best === undefined || score > best.score) {
      best = { head, score }
      continue
    }
    if (score === best.score && head.id < best.head.id) best = { head, score }
  }
  return best?.head
}
