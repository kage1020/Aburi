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

/** §3.4.5 — the weak matcher accepts a one-sided hit. */
const DROPPED_WEAK_THRESHOLD = 0.5

/** One candidate pairing and the score that ranks it against the others. */
interface ScoredPair {
  base: IRSymbol
  head: IRSymbol
  score: number
}

/**
 * §3.8 — accept candidate pairings highest score first, taking each base and each head at most
 * once. Stages 3, 4 and 4.5 all choose from a set of possible pairings, and all three used
 * to decide one head at a time — which let an earlier head consume a base that was a later
 * head’s exact match, and reported the loser as `added` beside the pair it lost.
 *
 * Ordering the candidates instead of the heads costs nothing: every score is computed either
 * way, and the sweep below is linear in the candidates that clear their threshold. It is not
 * an optimal assignment — a greedy sweep can still strand a pair whose partners were both
 * taken by higher-scoring ones — but it never passes over the best available pairing, which
 * is the case that shows up in a review as one symbol appearing twice.
 */
function acceptInScoreOrder(candidates: ScoredPair[]): ScoredPair[] {
  candidates.sort(compareCandidates)
  const usedBase = new Set<SymbolId>()
  const usedHead = new Set<SymbolId>()
  const accepted: ScoredPair[] = []
  for (const candidate of candidates) {
    if (usedBase.has(candidate.base.id) || usedHead.has(candidate.head.id)) continue
    usedBase.add(candidate.base.id)
    usedHead.add(candidate.head.id)
    accepted.push(candidate)
  }
  return accepted
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

function idsOf(pairs: readonly ScoredPair[], side: "base" | "head"): Set<SymbolId> {
  return new Set(pairs.map((pair) => pair[side].id))
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
  const claimants = new Map<SymbolId, { head: IRSymbol; bases: IRSymbol[] }>()
  for (const b of remainingBase) {
    const newPath = renameMap.get(b.source.file)
    if (newPath === undefined) continue
    const expectedId = rewriteIdFile(b.id, b.source.file, newPath)
    if (expectedId === null) continue
    const head = headById.get(expectedId)
    if (head === undefined) continue
    const claim = claimants.get(expectedId) ?? { head, bases: [] }
    claim.bases.push(b)
    claimants.set(expectedId, claim)
  }

  const matched: SymbolPair[] = []
  const usedBase = new Set<SymbolId>()
  const usedHead = new Set<SymbolId>()
  for (const { head, bases } of claimants.values()) {
    const base = lowestId(bases)
    if (base === undefined) continue
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

function lowestId(symbols: readonly IRSymbol[]): IRSymbol | undefined {
  let lowest: IRSymbol | undefined
  for (const symbol of symbols) {
    if (lowest === undefined || symbol.id < lowest.id) lowest = symbol
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
    if (accepted.length === 0) break
    for (const { base, head } of accepted) {
      matched.push({ base, head, rationale: "logic-fingerprint+name-disambiguation" })
    }
    freeBase = unclaimed(freeBase, idsOf(accepted, "base"))
    freeHead = unclaimed(freeHead, idsOf(accepted, "head"))
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
    matched: accepted.map(({ base, head }) => ({ base, head, rationale: "name-signature" })),
    remainingBase: unclaimed(remainingBase, idsOf(accepted, "base")),
    remainingHead: unclaimed(remainingHead, idsOf(accepted, "head")),
  }
}

function bucketKey(s: IRSymbol): string {
  const sig = s.signature === null || s.signature === undefined ? "no-sig" : "has-sig"
  return `${s.kind}::${sig}`
}

function thresholdFor(qname: string): number {
  const tokens = tokenizeName(lastSegment(qname)).length
  if (tokens <= 1) return 1
  if (tokens === 2) return 0.95
  return 0.85
}

/**
 * §3.4.5 — dropped-only weak matcher. For dropped Symbols the fingerprint is zeroed and
 * name/signature are the only remaining signals. Score is a coarse "did the last name
 * segment or file basename survive?" — if either half matches we pair (threshold 0.5).
 * Almost every score here is exactly 0.5, so which base pairs with which head is the
 * tie-break’s decision rather than the score’s.
 *
 * This is deliberately lax; diff-algorithm.md §3.4.5 already accepts that dropped Symbols live
 * outside the main IR review surface, so occasional false pairings only affect the
 * "Drop-rule variation" fold-out section in the Markdown projection.
 */
export function matchStageDroppedWeak(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const droppedBase = remainingBase.filter((s) => s.dropped)
  const candidates: ScoredPair[] = []
  for (const h of remainingHead) {
    if (!h.dropped) continue
    for (const b of droppedBase) {
      if (b.kind !== h.kind) continue
      const nameHit = lastSegment(b.name) === lastSegment(h.name) ? 1 : 0
      const fileHit = basename(b.source.file) === basename(h.source.file) ? 1 : 0
      const score = 0.5 * nameHit + 0.5 * fileHit
      if (score >= DROPPED_WEAK_THRESHOLD) candidates.push({ base: b, head: h, score })
    }
  }
  const accepted = acceptInScoreOrder(candidates)
  return {
    matched: accepted.map(({ base, head }) => ({
      base,
      head,
      rationale: "dropped-weak-match" as const,
    })),
    remainingBase: unclaimed(remainingBase, idsOf(accepted, "base")),
    remainingHead: unclaimed(remainingHead, idsOf(accepted, "head")),
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}
