import type { Symbol as IRSymbol, Logger } from "@aburi/types"
import { atLeast, quotient, type Ratio, WHOLE, weightedMean } from "../ratio"
import { signatureSimilarityRatio } from "../signature"
import { createNameScorer, lastSegment, type NameScorer, tokenizeName } from "../similarity"
import {
  type Assignment,
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
  logger?: Logger,
): StageResult {
  const compared = (symbol: IRSymbol): boolean => {
    if (symbol.dropped) return false
    const why = ruleRefusing(symbol)
    if (why === undefined) return true
    logger?.debug(`diff/stage4: ${symbol.id} is not compared by name: ${why}`)
    return false
  }
  const buckets = new Map<string, Bucket>()
  for (const baseSymbol of remainingBase) {
    if (!compared(baseSymbol)) continue
    const bucket: Bucket = buckets.get(baseSymbol.kind) ?? {
      members: [],
      byToken: new Map(),
      visited: new Int32Array(0),
      walks: 0,
    }
    const position = bucket.members.length
    bucket.members.push(baseSymbol)
    for (const token of memberTokens(baseSymbol.name)) {
      const sharing = bucket.byToken.get(token) ?? []
      sharing.push(position)
      bucket.byToken.set(token, sharing)
    }
    buckets.set(baseSymbol.kind, bucket)
  }
  for (const bucket of buckets.values()) bucket.visited = new Int32Array(bucket.members.length)
  const scorer = createNameScorer()
  const candidates: ScoredPair[] = []
  for (const headSymbol of remainingHead) {
    if (!compared(headSymbol)) continue
    const bucket = buckets.get(headSymbol.kind)
    if (bucket === undefined) continue
    const row = rowFor(headSymbol.name)
    for (const baseSymbol of basesSharingAToken(bucket, headSymbol)) {
      collectCandidate(baseSymbol, headSymbol, scorer, row, candidates)
    }
  }
  const assignment = acceptInScoreOrder(candidates)
  if (logger !== undefined) traceOwnerRefusals(buckets, remainingHead, assignment, scorer, logger)
  const matched: SymbolPair[] = assignment.pairs.map(({ base, head }) => ({
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
  const score = scoreOf(member, base, head)
  if (atLeast(score, row.threshold)) candidates.push({ base, head, score: quotient(score) })
}

// Run after acceptance, so a line names two Symbols that both reach stage 5 unpaired rather than a
// pair either of whose Symbols paired elsewhere.
function traceOwnerRefusals(
  buckets: ReadonlyMap<string, Bucket>,
  remainingHead: readonly IRSymbol[],
  assignment: Assignment,
  scorer: NameScorer,
  logger: Logger,
): void {
  for (const head of remainingHead) {
    if (head.dropped || assignment.headIds.has(head.id)) continue
    if (ruleRefusing(head) !== undefined) continue
    const bucket = buckets.get(head.kind)
    if (bucket === undefined) continue
    const row = rowFor(head.name)
    for (const base of basesSharingAToken(bucket, head)) {
      if (assignment.baseIds.has(base.id)) continue
      const member = scorer.member(base.name, head.name)
      if (!atLeast(member, row.memberFloor)) continue
      if (scorer.ownersCompatible(base.name, head.name)) continue
      if (!atLeast(scoreOf(member, base, head), row.threshold)) continue
      logger.debug(
        `diff/stage4: ${base.id} and ${head.id} are not paired: their owners do not correspond`,
      )
    }
  }
}

function scoreOf(member: Ratio, base: IRSymbol, head: IRSymbol): Ratio {
  return weightedMean([
    { weight: MEMBER_WEIGHT, value: member },
    {
      weight: SIGNATURE_WEIGHT,
      value: signatureSimilarityRatio(base.signature ?? null, head.signature ?? null),
    },
    { weight: OWNER_WEIGHT, value: OWNER_AXIS_SATISFIED },
  ])
}

const SAYS_TOO_LITTLE = "its name says too little to pair on"
const NO_SIGNATURE = "it has no signature, and a name alone does not pair"

function ruleRefusing(symbol: IRSymbol): string | undefined {
  if (!saysEnoughToPair(symbol.name)) return SAYS_TOO_LITTLE
  if (symbol.signature === null || symbol.signature === undefined) return NO_SIGNATURE
  return undefined
}

interface Bucket {
  readonly members: IRSymbol[]
  readonly byToken: Map<string, number[]>
  visited: Int32Array
  walks: number
}

function basesSharingAToken(bucket: Bucket, head: IRSymbol): readonly IRSymbol[] {
  const tokens = memberTokens(head.name)
  let reach = 0
  for (const token of tokens) reach += bucket.byToken.get(token)?.length ?? 0
  if (reach >= bucket.members.length) return bucket.members
  bucket.walks++
  const reached: IRSymbol[] = []
  for (const token of tokens) {
    for (const position of bucket.byToken.get(token) ?? []) {
      if (bucket.visited[position] === bucket.walks) continue
      bucket.visited[position] = bucket.walks
      const base = bucket.members[position]
      if (base !== undefined) reached.push(base)
    }
  }
  return reached
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
