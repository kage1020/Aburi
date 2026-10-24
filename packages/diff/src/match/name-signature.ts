import type { Symbol as IRSymbol } from "@aburi/types"
import { atLeast, quotient, type Ratio, WHOLE, weightedMean } from "../ratio"
import { signatureSimilarityRatio } from "../signature"
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
    const row = rowFor(headSymbol.name)
    const tokens = memberTokens(headSymbol.name)
    let reach = 0
    for (const token of tokens) reach += bucket.byToken.get(token)?.length ?? 0
    if (reach >= bucket.members.length) {
      for (const baseSymbol of bucket.members) {
        collectCandidate(baseSymbol, headSymbol, scorer, row, candidates)
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
          collectCandidate(baseSymbol, headSymbol, scorer, row, candidates)
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
  row: Row,
  candidates: ScoredPair[],
): void {
  const member = scorer.member(base.name, head.name)
  if (!atLeast(member, row.memberFloor)) return
  if (!scorer.ownersCompatible(base.name, head.name)) return
  const score = weightedMean([
    { weight: MEMBER_WEIGHT, value: member },
    {
      weight: SIGNATURE_WEIGHT,
      value: signatureSimilarityRatio(base.signature ?? null, head.signature ?? null),
    },
    { weight: OWNER_WEIGHT, value: OWNER_AXIS_SATISFIED },
  ])
  if (atLeast(score, row.threshold)) candidates.push({ base, head, score: quotient(score) })
}

function bucketKey(symbol: IRSymbol): string {
  const sig = symbol.signature === null || symbol.signature === undefined ? "no-sig" : "has-sig"
  return `${symbol.kind}::${sig}`
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

const MEMBER_WEIGHT = 5
const SIGNATURE_WEIGHT = 3
const OWNER_WEIGHT = 2
const OTHER_AXES_WEIGHT = SIGNATURE_WEIGHT + OWNER_WEIGHT
const TOTAL_WEIGHT = MEMBER_WEIGHT + OTHER_AXES_WEIGHT

const OWNER_AXIS_SATISFIED = WHOLE

interface Row {
  readonly threshold: Ratio
  readonly memberFloor: Ratio
}

function rowAt(threshold: Ratio): Row {
  return {
    threshold,
    memberFloor: {
      numerator: TOTAL_WEIGHT * threshold.numerator - OTHER_AXES_WEIGHT * threshold.denominator,
      denominator: MEMBER_WEIGHT * threshold.denominator,
    },
  }
}

const EXACT_MATCH_ONLY = rowAt(WHOLE)
const TWO_TOKEN_THRESHOLD = rowAt({ numerator: 19, denominator: 20 })
const DEFAULT_THRESHOLD = rowAt({ numerator: 17, denominator: 20 })

function rowFor(qname: string): Row {
  const tokens = tokenizeName(lastSegment(qname)).length
  if (tokens <= 1) return EXACT_MATCH_ONLY
  if (tokens === 2) return TWO_TOKEN_THRESHOLD
  return DEFAULT_THRESHOLD
}
