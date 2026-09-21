import { compareCodeUnit, groupBy, trySymbolId, ZERO_FINGERPRINT } from "@aburi/core"
import type { Symbol as IRSymbol, MatchRationale, SymbolId } from "@aburi/types"
import { signatureSimilarity } from "./signature"
import {
  createNameScorer,
  lastSegment,
  type NameScorer,
  nameEvidence,
  tokenizeName,
} from "./similarity"

/**
 * A concluded pairing of one base Symbol with one head Symbol, along with the
 * `MatchRationale` that placed them in the same pair. Stage 4 uses this shape both to
 * carry results out and to feed the delta / status classifier downstream.
 */
export interface SymbolPair {
  base: IRSymbol
  head: IRSymbol
  rationale: MatchRationale
}

/** Optional map returned by git for stage 2 (`old path` → `new path`). */
export type GitRenameMap = ReadonlyMap<string, string>

/** Stage 3 — the similarity a multi-candidate logic-fingerprint group must reach to pair. */
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

/**
 * Choosing among candidate pairings (diff-algorithm.md) — accept them highest score first, taking
 * each base and each head at most once. Deciding one head at a time let an earlier head consume a
 * base that was a later head's exact match. Not an optimal assignment — a greedy sweep can strand a
 * pair whose partners were both taken by higher-scoring ones — but it never passes over the best
 * available pairing. The same doc carries the O(base × head) bound on `candidates`.
 *
 * The consumed id sets come back with the pairings because every caller needs them, and
 * re-deriving them at the call site is a chance to read the wrong side. Stage 4.5 does not
 * call this: stage 4.5's candidates are all worth the same, see `bestPairing`.
 */
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

/**
 * Highest score first, then `(base.id, head.id)` ascending. The id keys make the order total
 * because ids are unique within a Document (ir-schema.md #1); without them equal scores
 * would resolve to enumeration order and the diff would stop being a function of the inputs.
 */
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

/**
 * Stage 1 (diff-algorithm.md) — segments Symbols with identical `id` into paired matches.
 * Runs first because it is the highest-confidence signal (no heuristics, just hash lookup).
 *
 * Assumes `id` is unique on each side (ir-schema.md #1) and does not check it:
 * `buildDiff` establishes that before calling, and a caller reaching this export directly
 * owns the obligation. A repeat on the head side loses all but the last entry to the lookup
 * map and then removes every one of them from `remainingHead`; a repeat on the base side
 * pairs the same head Symbol more than once. The later stages track consumed base Symbols
 * by id and lose a repeat the same way.
 */
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

/**
 * Stage 2 (diff-algorithm.md) — git rename detection. When a rename map is available
 * (typical of ref-driven scans), rewrite the base id with the head-side file path and look
 * for a hit. Two base files renamed onto one target predict the same head id, so the
 * claimants are collected before one is chosen.
 *
 * The rewriter only touches the `file` portion of the id — the `<language>:` prefix and
 * the trailing `#<qualified-name>` segment stay unchanged so a moved file with the same
 * qualified name is picked up correctly. When a Symbol's file is not in the rename map,
 * it is left for later stages.
 */
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

  // Collect every base that predicts a given head before choosing: which of two files renamed
  // onto one target is the move source should not be a property of the array order.
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

/**
 * Predict the id a base Symbol would carry after git moved its file, through `trySymbolId`
 * rather than by re-concatenating the parts, so a rename target the id grammar cannot express
 * (a backslash path, say) yields `null` instead of an id no head Symbol can equal. The caller
 * treats a null like a lookup miss, leaving the pair for stage 3.
 */
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

/**
 * Stage 3 (diff-algorithm.md) — group both sides by `fingerprint.logic` and pair within each
 * group. Two branches:
 * - single base candidate → paired with `logic-fingerprint`, no similarity test
 * - several → `nameSimilarity` disambiguates at ≥ 0.85; a group that cannot reach it is left
 *   whole for stage 4 to re-evaluate
 *
 * Dropped symbols are excluded — their logic fingerprint is the sentinel
 * `"000000000000"` and would collide with every other dropped Symbol in the workspace.
 * They flow to the stage-4.5 weak matcher instead.
 */
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
  for (const [logic, heads] of headGroups) {
    const bases = baseGroups.get(logic)
    if (bases === undefined) continue
    matched.push(...pairWithinLogicGroup(bases, heads, scorer))
  }
  const usedBase = new Set(matched.map((pair) => pair.base.id))
  const usedHead = new Set(matched.map((pair) => pair.head.id))
  return {
    matched,
    remainingBase: unclaimed(remainingBase, usedBase),
    remainingHead: unclaimed(remainingHead, usedHead),
  }
}

/** Symbols by logic fingerprint, skipping the ones stage 3 excludes; groups are self-contained. */
function groupByLogic(symbols: readonly IRSymbol[]): Map<string, IRSymbol[]> {
  return groupBy(
    symbols.filter((symbol) => !symbol.dropped && symbol.fingerprint.logic !== ZERO_FINGERPRINT),
    (symbol) => symbol.fingerprint.logic,
  )
}

/**
 * Stage 3’s two branches, over one logic-fingerprint group. A lone base candidate pairs with no
 * similarity test; with more than one, names disambiguate. The loop keeps the second branch
 * feeding the first: a scored round that consumes all but one base leaves that one
 * unconditional.
 */
function pairWithinLogicGroup(
  bases: readonly IRSymbol[],
  heads: readonly IRSymbol[],
  scorer: NameScorer,
): SymbolPair[] {
  let freeBase = [...bases]
  let freeHead = [...heads]
  const matched: SymbolPair[] = []
  while (freeBase.length > 0 && freeHead.length > 0) {
    const lone = freeBase.length === 1 ? freeBase[0] : undefined
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

/**
 * The head whose name is closest to `base`, ties going to the lower id. The lone-candidate
 * branch pairs whatever it is given, so this only decides *which* head it takes — but that
 * decision was array order, and it is visible in the diff.
 */
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

/**
 * Stage 4 (diff-algorithm.md) — name + signature similarity with a `(kind, signatureNullness)`
 * bucket pre-filter, so a class body is never paired against a function. The owner gate runs
 * before the score; over the pairs that clear it:
 *   0.5 * memberSimilarity + 0.3 * signatureSimilarity + 0.2 * OWNER_AXIS_SATISFIED
 * `memberSimilarity` reads the last segment only, since the gate has settled the owner and
 * reading it again would charge twice. Thresholds are per head, see `thresholdFor`; the two
 * Symbols the stage does not read at all are explained at `saysEnoughToPair`. Candidates are
 * settled in score order (`acceptInScoreOrder`), and `createNameScorer` pays for the full
 * bucket being scored by tokenising each name once per pass.
 */
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
    // See `saysEnoughToPair`. Read on the base as well as the head, because the
    // property belongs to a pairing.
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
    // `signatureSimilarity(null, null)` is 1.0, and the bucket key means a
    // signature-less head only ever sees signature-less candidates: nothing it could
    // legitimately pair with.
    if (headSymbol.signature === null || headSymbol.signature === undefined) continue
    if (!saysEnoughToPair(headSymbol.name)) continue
    const bucket = buckets.get(bucketKey(headSymbol))
    if (bucket === undefined) continue
    const threshold = thresholdFor(headSymbol.name)
    const memberFloor = lowestUsefulMember(threshold)
    // A base is reached once per token it shares, so a head whose postings add up to at least
    // the whole bucket is not being narrowed by the index (every `handleRequest` puts the
    // entire bucket under both tokens); walking the members straight through is cheaper than
    // de-duplicating. A bound, not a promise: `reach` double-counts.
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

/**
 * Score one candidate pairing and keep it if it clears the head's threshold. A plain
 * function rather than a closure per head, which measured ~1.6x slower on a bucket the index
 * cannot narrow. The member floor is read before the owner gate because it is one Jaccard
 * over token sets the pass already holds, where the gate tokenises and matches every segment.
 */
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
  // The threshold belongs to the head, so a pair below it is never acceptable however the
  // rest of the group resolves.
  if (score >= threshold) candidates.push({ base, head, score })
}

function bucketKey(symbol: IRSymbol): string {
  const sig = symbol.signature === null || symbol.signature === undefined ? "no-sig" : "has-sig"
  return `${symbol.kind}::${sig}`
}

/**
 * The least `memberSimilarity` that leaves `threshold` reachable: the other two axes
 * are worth at most 0.3 + 0.2, so `member >= 2 * (threshold - 0.5)`. Exact, not approximate.
 */
function lowestUsefulMember(threshold: number): number {
  return 2 * (threshold - 0.5)
}

/**
 * One `(kind, signatureNullness)` bucket: its base Symbols, and an index from each token a
 * member name carries to the positions holding it. The de-duplication stamp lives in
 * `visitsOf`, sized once the bucket is complete and shared across heads, so a head reaching
 * every base does not allocate a bucket-sized set per head.
 */
interface Bucket {
  members: IRSymbol[]
  byToken: Map<string, number[]>
}

/**
 * The token that stands in for a member name carrying none. `Foo.Bar.` is admissible
 * (two tokens in its qualified name) with an empty last segment; such Symbols can only pair
 * with each other, so they share a key of their own. `tokenizeName` never emits a space.
 */
const NO_MEMBER_TOKENS = " none"

function memberTokens(qname: string): readonly string[] {
  const tokens = tokenizeName(lastSegment(qname))
  return tokens.length === 0 ? [NO_MEMBER_TOKENS] : tokens
}

/**
 * The threshold table (diff-algorithm.md) — the composite score a pair must reach, by how
 * many tokens the head's last name segment has: 1 token → 1.0 (`0.5 + 0.3 + 0.2` is exactly
 * 1 in IEEE 754, reached on an identical member name and signature past a *compatible*
 * owner), 2 tokens → 0.95 (refuses `getUser` vs `getUsers`), otherwise 0.85.
 *
 * The token count, not `nameEvidence`, and deliberately: these rows are about how coarse a
 * Jaccard over those tokens can be, and the bar rises to meet that. One token against a name
 * of `n` scores 0 or `1/n`, so nothing short of an identical single token reaches 1.0 and the
 * composite tops out at `0.5 × 0.5 + 0.3 + 0.2 = 0.75` below it — under every row. A name of
 * one token really is all-or-nothing on its name axis, `ユーザー情報を取得する` included
 * however much it says, and the first row is right about it.
 */
const EXACT_MATCH_ONLY = 1
const TWO_TOKEN_THRESHOLD = 0.95
const DEFAULT_THRESHOLD = 0.85

/**
 * What the owner axis is worth to a pair past its gate. A value rather than folded
 * into the weights so the composite keeps the 0.5/0.3/0.2 shape the threshold table's rows are
 * calibrated against.
 */
const OWNER_AXIS_SATISFIED = 1

function thresholdFor(qname: string): number {
  const tokens = tokenizeName(lastSegment(qname)).length
  if (tokens <= 1) return EXACT_MATCH_ONLY
  if (tokens === 2) return TWO_TOKEN_THRESHOLD
  return DEFAULT_THRESHOLD
}

/**
 * Whether a Symbol's qualified name says enough for stage 4 to read it at all.
 *
 * A name saying one thing — `main`, or `Main.main` after dedup — scores the full 1.0 against
 * any other with the same signature, and 1.0 is the top of the scale, so no threshold can
 * refuse two unrelated CLI entry points reported as one move. Being unpairable is a property
 * of the name, decided here rather than by the score. Measured over the whole qualified name,
 * because that is what the score reads: `UserRepo.get` says three things and pairs, though
 * `thresholdFor` measures its last segment as one. Read off both sides, because the property
 * belongs to a pairing (`Main.main` clears the owner gate against `Mains.main` on an
 * identical member name).
 *
 * `nameEvidence` rather than the token count, which agree on a name whose words the tokeniser
 * can find and part company on a run it cannot segment: `ユーザー情報を取得する` is one token,
 * and a floor on the words in its runs puts it well past one, so two unrelated Symbols no more
 * carry it by coincidence than they carry `getUserInformation`. What it buys such a name is
 * narrower than this rule, since `thresholdFor` still reads one token and asks the full 1.0.
 */
function saysEnoughToPair(qname: string): boolean {
  return nameEvidence(qname) > 1
}

/**
 * Stage 4.5 (diff-algorithm.md) — dropped-only weak matcher. With the fingerprint zeroed, the only
 * signals left are the last segment of the qualified name and the file basename, and either alone
 * pairs — deliberately lax, since dropped Symbols sit outside the main review surface.
 *
 * What it does not accept is a signal that identifies nothing: a basename hit on `index.ts`
 * paired every dropped Symbol of one kind with every other and landed them in
 * `summary.moved`, which `--fail-on moved` gates on. So a half counts only when exactly one
 * dropped base and one dropped head carry that key — counted over the Symbols this stage is
 * handed, since a key the earlier stages emptied out identifies again. The candidates are
 * then the identifying keys themselves, at most `2 × min(base, head)` of them, all worth the
 * same; the score-ordered sweep would settle a conflict on nothing but id order, so
 * `bestPairing` takes a maximum matching instead.
 */
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

  // Both halves have the same standing, so the two axes are collected rather than consulted
  // in an order. Both naming the same pairing is a component of its own in `bestPairing`.
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

/**
 * As many of the identified pairings as can hold at once. Each axis identifies a Symbol at
 * most once, so the edge set is the union of two matchings — a disjoint union of simple paths
 * and even cycles — and alternate pairings along each component are a maximum matching of it.
 * Walking each component from a fixed end makes the choice canonical rather than a property
 * of the input order.
 */
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

  // Paths first, from an end — a component walked from the middle would not alternate to a
  // maximum. What is unwalked afterwards is on a cycle, where every pairing is an equally
  // good place to start and the lowest-ordered one is the canonical choice.
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

/**
 * The pairings a key picks out on its own: those whose key exactly one dropped base and one
 * dropped head carry. A key held by two Symbols on either side is discarded, not resolved.
 */
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

/**
 * The two halves stage 4.5 scores. `kind` leads because it gates a pair before either half is
 * read, and `/` separates because no kind, qualified-name segment or basename contains one.
 */
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
