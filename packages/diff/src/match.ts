import { trySymbolId } from "@aburi/core"
import type { Symbol as IRSymbol, MatchRationale, SymbolId } from "@aburi/types"
import { signatureSimilarity } from "./signature"
import { createNameScorer, lastSegment, type NameScorer, tokenizeName } from "./similarity"

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

/** Fingerprint for the 12-hex-char "everything zero" (i.e. dropped) canonical hash. */
const ZERO_LOGIC_FP = "000000000000"

/** §3.3 — the similarity a multi-candidate logic-fingerprint group must reach to pair. */
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
 * §3.8 — accept candidate pairings highest score first, taking each base and each head at
 * most once. Stages 3, 4 and 4.5 all choose from a set of possible pairings, and all three
 * used to decide one head at a time — which let an earlier head consume a base that was a
 * later head's exact match, and reported the loser as `added` beside the pair it lost.
 *
 * The two id sets come back with the pairings because every caller needs them to work out
 * what is left over, and deriving them again at the call site is a chance to derive the
 * wrong one: reading the head ids out as the base ids typechecks, and reproduces the very
 * symptom this exists to prevent.
 *
 * Not free, and §8.2 carries the bound: `candidates` is every pairing that clears its
 * threshold, so this holds O(base × head) records for stages 3 and 4 in the worst case where
 * the per-head loop it replaced held one, and sorting them is O(C log C). Stage 4 buys that
 * back and more with `createNameScorer`.
 *
 * It is not an optimal assignment — a greedy sweep can still strand a pair whose partners
 * were both taken by higher-scoring ones — but it never passes over the best available
 * pairing, which is the case that shows up in a review as one symbol appearing twice.
 *
 * Stage 4.5 does not call this, because that licence is what it cannot borrow: §3.4.5's
 * candidates are all worth the same, so no pairing is the best available and stranding one
 * buys nothing. See `bestPairing`.
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
 * Highest score first, then `(base.id, head.id)` ascending. The two id keys are what make
 * the order total, and they are a total order only because ids are unique within a Document
 * (ir-schema.md §14 #1), which `buildDiff` establishes before the first stage runs. Without
 * them equal scores resolve to enumeration order, and the diff stops being a function of the
 * two Documents.
 */
function compareCandidates(a: ScoredPair, b: ScoredPair): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.base.id !== b.base.id) return a.base.id < b.base.id ? -1 : 1
  return a.head.id < b.head.id ? -1 : a.head.id > b.head.id ? 1 : 0
}

/** The entries of `symbols` that no accepted pairing claimed, in their original order. */
function unclaimed(symbols: readonly IRSymbol[], claimed: ReadonlySet<SymbolId>): IRSymbol[] {
  return symbols.filter((symbol) => !claimed.has(symbol.id))
}

/**
 * §3.1 — segments Symbols with identical `id` into paired matches. Runs first because it
 * is the highest-confidence signal (no heuristics, just hash lookup).
 *
 * Assumes `id` is unique on each side (ir-schema.md §14 #1) and does not check it:
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
  for (const s of head) headById.set(s.id, s)
  const matched: SymbolPair[] = []
  const remainingBase: IRSymbol[] = []
  const usedHead = new Set<SymbolId>()
  for (const b of base) {
    const h = headById.get(b.id)
    if (h !== undefined) {
      matched.push({ base: b, head: h, rationale: "id-match" })
      usedHead.add(b.id)
    } else {
      remainingBase.push(b)
    }
  }
  const remainingHead = head.filter((h) => !usedHead.has(h.id))
  return { matched, remainingBase, remainingHead }
}

/**
 * §3.2 — git rename detection. When a rename map is available (typical of ref-driven
 * scans), rewrite the base id with the head-side file path and look for a hit. Two base
 * files renamed onto one target predict the same head id, so the claimants are collected
 * before one is chosen.
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
  for (const h of remainingHead) headById.set(h.id, h)

  // Collect every base that predicts a given head before choosing, rather than letting the
  // first one in the array take it. Two files renamed onto one target both predict the same
  // id, and which of them is the move source should not be a property of the array order.
  const claimants = new Map<SymbolId, { head: IRSymbol; bases: [IRSymbol, ...IRSymbol[]] }>()
  for (const b of remainingBase) {
    const newPath = renameMap.get(b.source.file)
    if (newPath === undefined) continue
    const expectedId = rewriteIdFile(b.id, b.source.file, newPath)
    if (expectedId === null) continue
    const head = headById.get(expectedId)
    if (head === undefined) continue
    const claim = claimants.get(expectedId)
    if (claim === undefined) claimants.set(expectedId, { head, bases: [b] })
    else claim.bases.push(b)
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
 * Predict the id a base Symbol would carry after git moved its file. The second Symbol-id
 * derivation in the codebase after `makeSymbolId` itself, so it goes back through the same
 * constructor rather than re-concatenating the parts: `trySymbolId` rejects a rename target
 * the id grammar cannot express (a backslash path, say) instead of minting an id no head
 * Symbol can ever equal.
 *
 * Returns `null` for that case, and the unchanged id when no rename applies — the caller
 * treats a null the same way it treats a lookup miss, leaving the pair for stage 3.
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
 * §3.3 — group both sides by `fingerprint.logic` and pair within each group. Two branches:
 * - single base candidate → paired with `logic-fingerprint`, no similarity test
 * - several → `nameSimilarity` disambiguates at ≥ 0.85; a group that cannot reach it is left
 *   whole for stage 4 to re-evaluate
 *
 * Dropped symbols are excluded (§3.3 tail) — their logic fingerprint is the sentinel
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

/**
 * Symbols by logic fingerprint, skipping the ones §3.3 excludes. Both sides are grouped, so
 * a group is a self-contained problem: the Symbols in it can only pair with each other, and
 * no group’s outcome depends on any other’s.
 */
function groupByLogic(symbols: readonly IRSymbol[]): Map<string, IRSymbol[]> {
  const groups = new Map<string, IRSymbol[]>()
  for (const symbol of symbols) {
    if (symbol.dropped || symbol.fingerprint.logic === ZERO_LOGIC_FP) continue
    const bucket = groups.get(symbol.fingerprint.logic) ?? []
    bucket.push(symbol)
    groups.set(symbol.fingerprint.logic, bucket)
  }
  return groups
}

/**
 * §3.3’s two branches, over one logic-fingerprint group.
 *
 * A lone base candidate pairs with no similarity test — identical logic is taken as proof on
 * its own. With more than one, names disambiguate and a group that cannot reach the
 * threshold is left whole for stage 4.
 *
 * The loop is what keeps the second branch feeding the first: a scored round that consumes
 * all but one base leaves that one unconditional, which is how the per-head version behaved
 * when its candidate list shrank to a single entry.
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
 * §3.4 — name + signature similarity with `(kind, signatureNullness)` bucket pre-filter.
 * `signatureNullness` distinguishes symbols with no signature (`interface`, `type`,
 * `class`) from callable ones so that a class body is never paired against a function.
 *
 * The composite score:
 *   0.5 * nameSimilarity + 0.3 * signatureSimilarity + 0.2 * ownerSimilarity
 *
 * §3.4.3 threshold table, applied per head:
 * - 1-token name → 1.0 (the false-positive shield)
 * - 2-token name → 0.95 (strict, avoids `getUser` vs `getUsers`)
 * - default      → 0.85
 *
 * §3.4.3 tail — a signature-less head is not paired at all, because
 * `signatureSimilarity(null, null)` is 1.0 and the bucket key already restricts it to
 * candidates that are equally signature-less.
 *
 * Every pairing in a bucket that clears its head’s threshold becomes a candidate, and the
 * candidates are settled in score order rather than one head at a time — see
 * `acceptInScoreOrder`. That doubles the pairings scored, from a bucket that shrank as heads
 * consumed it to the full bucket every time; `createNameScorer` more than pays for it by
 * tokenising each distinct name once per pass instead of once per comparison.
 */
export function matchStageNameSignature(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const buckets = new Map<string, IRSymbol[]>()
  for (const b of remainingBase) {
    if (b.dropped) continue
    const key = bucketKey(b)
    const bucket = buckets.get(key) ?? []
    bucket.push(b)
    buckets.set(key, bucket)
  }
  const scorer = createNameScorer()
  const candidates: ScoredPair[] = []
  for (const h of remainingHead) {
    if (h.dropped) continue
    // §3.4.3 tail — `signatureSimilarity(null, null)` is 1.0, so a signature-less head would
    // score every candidate high on that axis. The bucket key already partitions by
    // signature nullness, so a signature-less head only ever sees signature-less candidates:
    // there is nothing here it could legitimately pair with.
    if (h.signature === null || h.signature === undefined) continue
    const bucket = buckets.get(bucketKey(h))
    if (bucket === undefined) continue
    const threshold = thresholdFor(h.name)
    for (const b of bucket) {
      const score =
        0.5 * scorer.name(b.name, h.name) +
        0.3 * signatureSimilarity(b.signature ?? null, h.signature ?? null) +
        0.2 * scorer.owner(b.name, h.name)
      // Filtering here rather than after the sweep keeps the candidate list to the pairings
      // that could actually be accepted; the threshold belongs to the head, so a pair below
      // it is never acceptable however the rest of the group resolves.
      if (score >= threshold) candidates.push({ base: b, head: h, score })
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

function bucketKey(s: IRSymbol): string {
  const sig = s.signature === null || s.signature === undefined ? "no-sig" : "has-sig"
  return `${s.kind}::${sig}`
}

/**
 * §3.4.3 — the composite score a pair must reach, by how many tokens the head's last name
 * segment has. 1.0 is reachable, not impossible: an identical name with an identical
 * signature and owner is `0.5 + 0.3 + 0.2`, exactly 1 in IEEE 754, so a one-token name pairs
 * when nothing but its file changed and never otherwise.
 */
const EXACT_MATCH_ONLY = 1
const TWO_TOKEN_THRESHOLD = 0.95
const DEFAULT_THRESHOLD = 0.85

function thresholdFor(qname: string): number {
  const tokens = tokenizeName(lastSegment(qname)).length
  if (tokens <= 1) return EXACT_MATCH_ONLY
  if (tokens === 2) return TWO_TOKEN_THRESHOLD
  return DEFAULT_THRESHOLD
}

/**
 * §3.4.5 — dropped-only weak matcher. For dropped Symbols the fingerprint is zeroed, so the
 * only signals left are the trailing segment of the qualified name and the file basename.
 * Either one alone is enough to pair, which is deliberately lax: §3.4.5 accepts a
 * false-positive risk because dropped Symbols sit outside the IR's main review surface.
 *
 * What it does not accept is a signal that identifies nothing. A basename hit on `index.ts`
 * — the most common filename in a TypeScript monorepo — paired every dropped Symbol of one
 * kind under one with every other, at a score they all tied on, and the results landed in
 * `summary.moved`, which `--fail-on moved` gates on. So a half counts only when exactly one
 * dropped base and one dropped head carry that key: such a key names a pair, where a key
 * several Symbols carry names a group, and a group is not a pairing.
 *
 * That makes the candidates the identifying keys themselves — at most one pairing each,
 * two axes, so at most `2 × min(base, head)` of them rather than the cross-product a shared
 * basename used to produce.
 *
 * "Exactly one" is counted over the Symbols this stage is handed, not over every dropped
 * Symbol in the Document — stages 1 and 2 have already taken theirs, and a key they emptied
 * out identifies again. That is the intended reading, since the question is which leftover a
 * key picks out, but it is also how a shared `index.ts` comes back: three dropped classes
 * under one, two of them matched by id, and the basename identifies the two that are left.
 *
 * It also leaves nothing for §3.4.5's 0.5-per-half scale to rank, so §3.8's sweep is the
 * wrong instrument: it settles conflicts by score, and with none to settle by it would drop
 * one identified pairing for another over nothing but the id it sorts under. `bestPairing`
 * takes a maximum matching instead.
 */
export function matchStageDroppedWeak(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const bases = remainingBase.filter((s) => s.dropped)
  const heads = remainingHead.filter((s) => s.dropped)

  // Both halves have the same standing, so the two axes are collected rather than consulted
  // in an order. Both naming the same pairing needs no special handling: each key is sole on
  // both sides, so neither Symbol carries another pairing and the repeat is a component of
  // its own, which `bestPairing` takes once.
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

/** A pairing that one of §3.4.5's two keys identifies. */
interface WeakEdge {
  base: IRSymbol
  head: IRSymbol
}

/**
 * As many of the identified pairings as can hold at once.
 *
 * Each axis identifies a Symbol at most once, so a Symbol carries at most two pairings and
 * the whole set is the union of two matchings — which is a disjoint union of simple paths and
 * even cycles. Alternate pairings along a component are therefore a maximum matching of it,
 * and walking each component from a fixed end makes the choice among the maximum matchings
 * canonical rather than a property of the input order.
 *
 * The alternative would be §3.8's sweep, and it is the wrong instrument once §3.4.5's score
 * is gone: over `Shared.ts#Alpha`, `Other.ts#Beta` against `Other.ts#Alpha`,
 * `Shared.ts#Gamma`, all three pairings are identified and it takes one where two hold.
 */
function bestPairing(edges: readonly WeakEdge[]): WeakEdge[] {
  const ordered = [...edges].sort(byEndpoints)
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

function byEndpoints(a: WeakEdge, b: WeakEdge): number {
  if (a.base.id !== b.base.id) return a.base.id < b.base.id ? -1 : 1
  return a.head.id < b.head.id ? -1 : a.head.id > b.head.id ? 1 : 0
}

function appendTo(table: Map<SymbolId, number[]>, key: SymbolId, index: number): void {
  const bucket = table.get(key)
  if (bucket === undefined) table.set(key, [index])
  else bucket.push(index)
}

/**
 * The pairings a key picks out on its own: those whose key exactly one dropped base and one
 * dropped head carry. A key held by two Symbols on either side is discarded rather than
 * resolved — with the fingerprint zeroed there is nothing left to tell the members apart, and
 * guessing between them is the false pairing this rule exists to refuse.
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
 * The two halves §3.4.5 scores. `kind` leads because it gates a pair before either half is
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
