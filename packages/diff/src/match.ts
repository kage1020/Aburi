import { compareCodeUnit, logicNamesNothing, trySymbolId, ZERO_FINGERPRINT } from "@aburi/core"
import type { Symbol as IRSymbol, MatchRationale, SymbolId } from "@aburi/types"
import { signatureSimilarity } from "./signature"
import {
  createNameScorer,
  lastSegment,
  type NameScorer,
  nameEvidence,
  tokenizeName,
} from "./similarity"

export interface SymbolPair {
  base: IRSymbol
  head: IRSymbol
  rationale: MatchRationale
}

/** Optional map returned by git for stage 2 (`old path` → `new path`). */
export type GitRenameMap = ReadonlyMap<string, string>

const NAME_DISAMBIGUATION_THRESHOLD = 0.85

/** One candidate pairing and the score that ranks it against the others. */
interface ScoredPair {
  base: IRSymbol
  head: IRSymbol
  score: number
}

/** What one sweep settled: the pairings, and the ids each side spent on them. */
interface Assignment {
  pairs: readonly ScoredPair[]
  baseIds: ReadonlySet<SymbolId>
  headIds: ReadonlySet<SymbolId>
}

function acceptInScoreOrder(candidates: ScoredPair[]): Assignment {
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

function compareByEndpoints(a: WeakEdge, b: WeakEdge): number {
  return compareCodeUnit(a.base.id, b.base.id) || compareCodeUnit(a.head.id, b.head.id)
}

/** The entries of `symbols` that no accepted pairing claimed, in their original order. */
function unclaimed(symbols: readonly IRSymbol[], claimed: ReadonlySet<SymbolId>): IRSymbol[] {
  return symbols.filter((symbol) => !claimed.has(symbol.id))
}

export function matchStageId(
  base: readonly IRSymbol[],
  head: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const headById = new Map<SymbolId, IRSymbol>()
  for (const symbol of head) headById.set(symbol.id, symbol)
  const matched: SymbolPair[] = []
  const remainingBase: IRSymbol[] = []
  const usedHead = new Set<SymbolId>()
  for (const baseSymbol of base) {
    const headSymbol = headById.get(baseSymbol.id)
    if (headSymbol !== undefined) {
      matched.push({ base: baseSymbol, head: headSymbol, rationale: "id-match" })
      usedHead.add(baseSymbol.id)
    } else {
      remainingBase.push(baseSymbol)
    }
  }
  const remainingHead = unclaimed(head, usedHead)
  return { matched, remainingBase, remainingHead }
}

export function matchStageGitRename(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
  renameMap: GitRenameMap | null,
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  if (renameMap === null || renameMap.size === 0) {
    return { matched: [], remainingBase: [...remainingBase], remainingHead: [...remainingHead] }
  }
  const headById = new Map<SymbolId, IRSymbol>()
  for (const symbol of remainingHead) headById.set(symbol.id, symbol)

  const claimants = new Map<SymbolId, { head: IRSymbol; bases: [IRSymbol, ...IRSymbol[]] }>()
  for (const baseSymbol of remainingBase) {
    const newPath = renameMap.get(baseSymbol.source.file)
    if (newPath === undefined) continue
    const expectedId = rewriteIdFile(baseSymbol.id, baseSymbol.source.file, newPath)
    if (expectedId === null) continue
    const head = headById.get(expectedId)
    if (head === undefined) continue
    const claim = claimants.get(expectedId)
    if (claim === undefined) claimants.set(expectedId, { head, bases: [baseSymbol] })
    else claim.bases.push(baseSymbol)
  }

  const matched: SymbolPair[] = []
  const usedBase = new Set<SymbolId>()
  const usedHead = new Set<SymbolId>()
  for (const { head, bases } of claimants.values()) {
    const base = lowestId(bases)
    matched.push({ base, head, rationale: "git-rename" })
    usedBase.add(base.id)
    usedHead.add(head.id)
  }
  return {
    matched,
    remainingBase: unclaimed(remainingBase, usedBase),
    remainingHead: unclaimed(remainingHead, usedHead),
  }
}

/** Total on the non-empty claim lists above: a claim is created holding its first base. */
function lowestId(symbols: readonly [IRSymbol, ...IRSymbol[]]): IRSymbol {
  let lowest = symbols[0]
  for (const symbol of symbols) {
    if (symbol.id < lowest.id) lowest = symbol
  }
  return lowest
}

function rewriteIdFile(id: SymbolId, oldPath: string, newPath: string): SymbolId | null {
  const colon = id.indexOf(":")
  const hash = id.indexOf("#")
  if (colon < 0 || hash < 0 || hash < colon) return id
  const filePart = id.slice(colon + 1, hash)
  if (filePart !== oldPath) return id
  return trySymbolId({
    language: id.slice(0, colon),
    file: newPath,
    qualifiedName: id.slice(hash + 1),
  })
}

export function matchStageLogicFingerprint(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const baseGroups = groupByLogic(remainingBase)
  const headGroups = groupByLogic(remainingHead)
  const scorer = createNameScorer()
  const matched: SymbolPair[] = []
  for (const [key, heads] of headGroups) {
    const bases = baseGroups.get(key)
    if (bases === undefined) continue
    matched.push(...pairWithinLogicGroup(bases.symbols, heads.symbols, scorer, heads.evidenceless))
  }
  const usedBase = new Set(matched.map((pair) => pair.base.id))
  const usedHead = new Set(matched.map((pair) => pair.head.id))
  return {
    matched,
    remainingBase: unclaimed(remainingBase, usedBase),
    remainingHead: unclaimed(remainingHead, usedHead),
  }
}

/** The Symbols of one stage-3 group, and whether the logic fingerprint they share is evidence. */
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

export function matchStageNameSignature(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
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
  const accepted = acceptInScoreOrder(candidates)
  return {
    matched: accepted.pairs.map(({ base, head }) => ({
      base,
      head,
      rationale: "name-signature" as const,
    })),
    remainingBase: unclaimed(remainingBase, accepted.baseIds),
    remainingHead: unclaimed(remainingHead, accepted.headIds),
  }
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

function saysEnoughToPair(qname: string): boolean {
  return nameEvidence(qname) > 1
}

export function matchStageDroppedWeak(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const bases = remainingBase.filter((symbol) => symbol.dropped)
  const heads = remainingHead.filter((symbol) => symbol.dropped)

  const identified: WeakEdge[] = []
  for (const keyOf of [nameKey, fileKey]) {
    identified.push(...pairsIdentifiedBy(bases, heads, keyOf))
  }

  const matched = bestPairing(identified)
  return {
    matched: matched.map(({ base, head }) => ({
      base,
      head,
      rationale: "dropped-weak-match" as const,
    })),
    remainingBase: unclaimed(remainingBase, new Set(matched.map((edge) => edge.base.id))),
    remainingHead: unclaimed(remainingHead, new Set(matched.map((edge) => edge.head.id))),
  }
}

/** A pairing that one of stage 4.5's two keys identifies. */
interface WeakEdge {
  base: IRSymbol
  head: IRSymbol
}

function bestPairing(edges: readonly WeakEdge[]): WeakEdge[] {
  const ordered = [...edges].sort(compareByEndpoints)
  const atBase = new Map<SymbolId, number[]>()
  const atHead = new Map<SymbolId, number[]>()
  for (const [index, edge] of ordered.entries()) {
    appendTo(atBase, edge.base.id, index)
    appendTo(atHead, edge.head.id, index)
  }
  const adjacent = (index: number): number[] => {
    const edge = ordered[index]
    if (edge === undefined) return []
    const sharing = [...(atBase.get(edge.base.id) ?? []), ...(atHead.get(edge.head.id) ?? [])]
    return sharing.filter((other) => other !== index)
  }

  const walked = ordered.map(() => false)
  const matching: WeakEdge[] = []
  /** Follow a component from `start`, taking every other pairing along it. */
  const walkFrom = (start: number): void => {
    let step = start
    let take = true
    while (!walked[step]) {
      walked[step] = true
      const edge = ordered[step]
      if (take && edge !== undefined) matching.push(edge)
      take = !take
      const next = adjacent(step).find((other) => walked[other] === false)
      if (next === undefined) return
      step = next
    }
  }

  for (const [index] of ordered.entries()) {
    if (!walked[index] && adjacent(index).length <= 1) walkFrom(index)
  }
  for (const [index] of ordered.entries()) {
    if (!walked[index]) walkFrom(index)
  }
  return matching
}

function appendTo(table: Map<SymbolId, number[]>, key: SymbolId, index: number): void {
  const bucket = table.get(key)
  if (bucket === undefined) table.set(key, [index])
  else bucket.push(index)
}

function pairsIdentifiedBy(
  bases: readonly IRSymbol[],
  heads: readonly IRSymbol[],
  keyOf: (symbol: IRSymbol) => string,
): WeakEdge[] {
  const soleBase = soleCarriers(bases, keyOf)
  const soleHead = soleCarriers(heads, keyOf)
  const pairs: WeakEdge[] = []
  for (const [key, base] of soleBase) {
    const head = soleHead.get(key)
    if (head !== undefined) pairs.push({ base, head })
  }
  return pairs
}

/** Keys carried by exactly one of `symbols`, mapped to it. */
function soleCarriers(
  symbols: readonly IRSymbol[],
  keyOf: (symbol: IRSymbol) => string,
): Map<string, IRSymbol> {
  const sole = new Map<string, IRSymbol>()
  const shared = new Set<string>()
  for (const symbol of symbols) {
    const key = keyOf(symbol)
    if (shared.has(key)) continue
    if (sole.has(key)) {
      sole.delete(key)
      shared.add(key)
      continue
    }
    sole.set(key, symbol)
  }
  return sole
}

function nameKey(symbol: IRSymbol): string {
  return `${symbol.kind}/${lastSegment(symbol.name)}`
}

function fileKey(symbol: IRSymbol): string {
  return `${symbol.kind}/${basename(symbol.source.file)}`
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}
