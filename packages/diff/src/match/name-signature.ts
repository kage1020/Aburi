import type { Symbol as IRSymbol } from "@aburi/types"
import { signatureSimilarity } from "../signature"
import { createNameScorer, lastSegment, type NameScorer, tokenizeName } from "../similarity"
import {
  acceptInScoreOrder,
  type ScoredPair,
  type StageResult,
  type SymbolPair,
  saysEnoughToPair,
  stageResult,
} from "./pairing"

export function matchStageNameSignature(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): StageResult {
  const buckets = new Map<string, Bucket>()
  for (const baseSymbol of remainingBase) {
    if (baseSymbol.dropped) continue
    if (!saysEnoughToPair(baseSymbol.name)) continue
    const key = bucketKey(baseSymbol)
    const bucket: Bucket = buckets.get(key) ?? { members: [], byToken: new Map() }
    const position = bucket.members.length
    bucket.members.push(baseSymbol)
    for (const token of memberTokens(baseSymbol.name)) {
      const sharing = bucket.byToken.get(token) ?? []
      sharing.push(position)
      bucket.byToken.set(token, sharing)
    }
    buckets.set(key, bucket)
  }
  const visitsOf = new Map<Bucket, Int32Array>()
  for (const bucket of buckets.values()) visitsOf.set(bucket, new Int32Array(bucket.members.length))
  const scorer = createNameScorer()
  const candidates: ScoredPair[] = []
  let visitCount = 0
  for (const headSymbol of remainingHead) {
    if (headSymbol.dropped) continue
    if (headSymbol.signature === null || headSymbol.signature === undefined) continue
    if (!saysEnoughToPair(headSymbol.name)) continue
    const bucket = buckets.get(bucketKey(headSymbol))
    if (bucket === undefined) continue
    const threshold = thresholdFor(headSymbol.name)
    const memberFloor = lowestUsefulMember(threshold)
    const tokens = memberTokens(headSymbol.name)
    let reach = 0
    for (const token of tokens) reach += bucket.byToken.get(token)?.length ?? 0
    if (reach >= bucket.members.length) {
      for (const baseSymbol of bucket.members) {
        collectCandidate(baseSymbol, headSymbol, scorer, memberFloor, threshold, candidates)
      }
      continue
    }
    const visited = visitsOf.get(bucket)
    if (visited === undefined) continue
    visitCount++
    for (const token of tokens) {
      for (const position of bucket.byToken.get(token) ?? []) {
        if (visited[position] === visitCount) continue
        visited[position] = visitCount
        const baseSymbol = bucket.members[position]
        if (baseSymbol !== undefined) {
          collectCandidate(baseSymbol, headSymbol, scorer, memberFloor, threshold, candidates)
        }
      }
    }
  }
  const matched: SymbolPair[] = acceptInScoreOrder(candidates).pairs.map(({ base, head }) => ({
    base,
    head,
    rationale: "name-signature",
  }))
  return stageResult(matched, remainingBase, remainingHead)
}

function collectCandidate(
  base: IRSymbol,
  head: IRSymbol,
  scorer: NameScorer,
  memberFloor: number,
  threshold: number,
  candidates: ScoredPair[],
): void {
  const member = scorer.member(base.name, head.name)
  if (member < memberFloor) return
  if (!scorer.ownersCompatible(base.name, head.name)) return
  const score =
    0.5 * member +
    0.3 * signatureSimilarity(base.signature ?? null, head.signature ?? null) +
    0.2 * OWNER_AXIS_SATISFIED
  if (score >= threshold) candidates.push({ base, head, score })
}

function bucketKey(symbol: IRSymbol): string {
  const sig = symbol.signature === null || symbol.signature === undefined ? "no-sig" : "has-sig"
  return `${symbol.kind}::${sig}`
}

function lowestUsefulMember(threshold: number): number {
  return 2 * (threshold - 0.5)
}

interface Bucket {
  members: IRSymbol[]
  byToken: Map<string, number[]>
}

const NO_MEMBER_TOKENS = " none"

function memberTokens(qname: string): readonly string[] {
  const tokens = tokenizeName(lastSegment(qname))
  return tokens.length === 0 ? [NO_MEMBER_TOKENS] : tokens
}

const EXACT_MATCH_ONLY = 1
const TWO_TOKEN_THRESHOLD = 0.95
const DEFAULT_THRESHOLD = 0.85

const OWNER_AXIS_SATISFIED = 1

function thresholdFor(qname: string): number {
  const tokens = tokenizeName(lastSegment(qname)).length
  if (tokens <= 1) return EXACT_MATCH_ONLY
  if (tokens === 2) return TWO_TOKEN_THRESHOLD
  return DEFAULT_THRESHOLD
}
