import type { Symbol as IRSymbol, MatchRationale } from "@aburi/types"
import { signatureSimilarity } from "./signature"
import { nameSimilarity, ownerSimilarity, tokenizeName } from "./similarity"

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

/**
 * §3.1 — segments Symbols with identical `id` into paired matches. Runs first because it
 * is the highest-confidence signal (no heuristics, just hash lookup).
 */
export function matchStageId(
  base: readonly IRSymbol[],
  head: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  const headById = new Map<string, IRSymbol>()
  for (const s of head) headById.set(s.id, s)
  const matched: SymbolPair[] = []
  const remainingBase: IRSymbol[] = []
  const usedHead = new Set<string>()
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
 * scans), rewrite the base id with the head-side file path and look for a hit.
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
  const headById = new Map<string, IRSymbol>()
  for (const h of remainingHead) headById.set(h.id, h)
  const matched: SymbolPair[] = []
  const usedHead = new Set<string>()
  const remaining: IRSymbol[] = []
  for (const b of remainingBase) {
    const newPath = renameMap.get(b.source.file)
    if (newPath === undefined) {
      remaining.push(b)
      continue
    }
    const expectedId = rewriteIdFile(b.id, b.source.file, newPath)
    const h = headById.get(expectedId)
    if (h === undefined || usedHead.has(h.id)) {
      remaining.push(b)
      continue
    }
    matched.push({ base: b, head: h, rationale: "git-rename" })
    usedHead.add(h.id)
  }
  const remainingHeadOut = remainingHead.filter((h) => !usedHead.has(h.id))
  return { matched, remainingBase: remaining, remainingHead: remainingHeadOut }
}

function rewriteIdFile(id: string, oldPath: string, newPath: string): string {
  const colon = id.indexOf(":")
  const hash = id.indexOf("#")
  if (colon < 0 || hash < 0 || hash < colon) return id
  const language = id.slice(0, colon)
  const filePart = id.slice(colon + 1, hash)
  if (filePart !== oldPath) return id
  const rest = id.slice(hash)
  return `${language}:${newPath}${rest}`
}

/**
 * §3.3 — group base Symbols by `fingerprint.logic` and match head Symbols whose logic
 * fingerprint is in the map. Two disambiguation branches:
 * - single candidate → paired with `logic-fingerprint`
 * - multiple candidates → best `nameSimilarity` wins if ≥ 0.85; otherwise leave both
 *   sides in remaining for stage 4 to re-evaluate
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
  const logicMap = new Map<string, IRSymbol[]>()
  const carryBase: IRSymbol[] = []
  for (const b of remainingBase) {
    if (b.dropped || b.fingerprint.logic === ZERO_LOGIC_FP) {
      carryBase.push(b)
      continue
    }
    const bucket = logicMap.get(b.fingerprint.logic) ?? []
    bucket.push(b)
    logicMap.set(b.fingerprint.logic, bucket)
  }
  const matched: SymbolPair[] = []
  const carryHead: IRSymbol[] = []
  const usedBaseIds = new Set<string>()
  for (const h of remainingHead) {
    if (h.dropped || h.fingerprint.logic === ZERO_LOGIC_FP) {
      carryHead.push(h)
      continue
    }
    const candidates = logicMap.get(h.fingerprint.logic)
    if (candidates === undefined || candidates.length === 0) {
      carryHead.push(h)
      continue
    }
    if (candidates.length === 1) {
      const only = candidates[0] as IRSymbol
      matched.push({ base: only, head: h, rationale: "logic-fingerprint" })
      usedBaseIds.add(only.id)
      logicMap.delete(h.fingerprint.logic)
      continue
    }
    let best: { symbol: IRSymbol; score: number } | null = null
    for (const c of candidates) {
      const score = nameSimilarity(c.name, h.name)
      if (best === null || score > best.score) best = { symbol: c, score }
    }
    if (best !== null && best.score >= 0.85) {
      matched.push({
        base: best.symbol,
        head: h,
        rationale: "logic-fingerprint+name-disambiguation",
      })
      usedBaseIds.add(best.symbol.id)
      const remainingBucket = candidates.filter((c) => c.id !== best?.symbol.id)
      if (remainingBucket.length === 0) logicMap.delete(h.fingerprint.logic)
      else logicMap.set(h.fingerprint.logic, remainingBucket)
    } else {
      carryHead.push(h)
    }
  }
  const finalBase: IRSymbol[] = [...carryBase]
  for (const bucket of logicMap.values()) {
    for (const b of bucket) {
      if (!usedBaseIds.has(b.id)) finalBase.push(b)
    }
  }
  return { matched, remainingBase: finalBase, remainingHead: carryHead }
}

/**
 * §3.4 — name + signature similarity with `(kind, signatureNullness)` bucket pre-filter.
 * `signatureNullness` distinguishes symbols with no signature (`interface`, `type`,
 * `class`) from callable ones so that a class body is never paired against a function.
 *
 * The composite score:
 *   0.5 * nameSimilarity + 0.3 * signatureSimilarity + 0.2 * ownerSimilarity
 *
 * §3.4.3 threshold table:
 * - 1-token name → 1.0 (unreachable → never paired; false-positive shield)
 * - 2-token name → 0.95 (strict, avoids `getUser` vs `getUsers`)
 * - default      → 0.85
 *
 * §3.4.3 tail — if both sides are signature-less, we skip pairing entirely because
 * signatureSimilarity always returns 1.0 for `null + null` and would flood the bucket with
 * false pairings.
 */
export function matchStageNameSignature(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): {
  matched: SymbolPair[]
  remainingBase: IRSymbol[]
  remainingHead: IRSymbol[]
} {
  type BucketKey = string
  const buckets = new Map<BucketKey, IRSymbol[]>()
  for (const b of remainingBase) {
    if (b.dropped) continue
    const key = bucketKey(b)
    const bucket = buckets.get(key) ?? []
    bucket.push(b)
    buckets.set(key, bucket)
  }
  const matched: SymbolPair[] = []
  const remainingHeadOut: IRSymbol[] = []
  const usedBaseIds = new Set<string>()
  for (const h of remainingHead) {
    if (h.dropped) {
      remainingHeadOut.push(h)
      continue
    }
    const key = bucketKey(h)
    const bucket = buckets.get(key)
    if (bucket === undefined || bucket.length === 0) {
      remainingHeadOut.push(h)
      continue
    }
    const headSigNull = h.signature === null || h.signature === undefined
    if (headSigNull && bucket.every((c) => c.signature === null || c.signature === undefined)) {
      remainingHeadOut.push(h)
      continue
    }
    let best: { symbol: IRSymbol; score: number } | null = null
    for (const c of bucket) {
      const score =
        0.5 * nameSimilarity(c.name, h.name) +
        0.3 * signatureSimilarity(c.signature ?? null, h.signature ?? null) +
        0.2 * ownerSimilarity(c.name, h.name)
      if (best === null || score > best.score) best = { symbol: c, score }
    }
    const threshold = thresholdFor(h.name)
    if (best !== null && best.score >= threshold) {
      matched.push({ base: best.symbol, head: h, rationale: "name-signature" })
      usedBaseIds.add(best.symbol.id)
      buckets.set(
        key,
        bucket.filter((c) => c.id !== best?.symbol.id),
      )
    } else {
      remainingHeadOut.push(h)
    }
  }
  const remainingBaseOut: IRSymbol[] = []
  for (const b of remainingBase) {
    if (b.dropped) {
      remainingBaseOut.push(b)
      continue
    }
    if (!usedBaseIds.has(b.id)) remainingBaseOut.push(b)
  }
  return { matched, remainingBase: remainingBaseOut, remainingHead: remainingHeadOut }
}

function bucketKey(s: IRSymbol): string {
  const sig = s.signature === null || s.signature === undefined ? "no-sig" : "has-sig"
  return `${s.kind}::${sig}`
}

function thresholdFor(qname: string): number {
  const last = lastSegmentForBucket(qname)
  const tokens = tokenizeName(last).length
  if (tokens <= 1) return 1
  if (tokens === 2) return 0.95
  return 0.85
}

function lastSegmentForBucket(qname: string): string {
  const staticIdx = qname.indexOf("::")
  if (staticIdx >= 0) return qname.slice(staticIdx + 2)
  const lastDot = qname.lastIndexOf(".")
  if (lastDot >= 0) return qname.slice(lastDot + 1)
  return qname
}

/**
 * §3.4.5 — dropped-only weak matcher. For dropped Symbols the fingerprint is zeroed and
 * name/signature are the only remaining signals. Score is a coarse "did the last name
 * segment or file basename survive?" — if either half matches we pair (threshold 0.5).
 *
 * This is deliberately lax; drop-list.md §3 already accepts that dropped Symbols live
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
  const nonDroppedBase = remainingBase.filter((s) => !s.dropped)
  const droppedHead = remainingHead.filter((s) => s.dropped)
  const nonDroppedHead = remainingHead.filter((s) => !s.dropped)
  const matched: SymbolPair[] = []
  const usedBaseIds = new Set<string>()
  const carryHead: IRSymbol[] = []
  for (const h of droppedHead) {
    let best: { symbol: IRSymbol; score: number } | null = null
    for (const b of droppedBase) {
      if (b.kind !== h.kind) continue
      if (usedBaseIds.has(b.id)) continue
      const nameHit = lastNameSegment(b.name) === lastNameSegment(h.name) ? 1 : 0
      const fileHit = basename(b.source.file) === basename(h.source.file) ? 1 : 0
      const score = 0.5 * nameHit + 0.5 * fileHit
      if (best === null || score > best.score) best = { symbol: b, score }
    }
    if (best !== null && best.score >= 0.5) {
      matched.push({ base: best.symbol, head: h, rationale: "dropped-weak-match" })
      usedBaseIds.add(best.symbol.id)
    } else {
      carryHead.push(h)
    }
  }
  const carryBase: IRSymbol[] = [
    ...nonDroppedBase,
    ...droppedBase.filter((b) => !usedBaseIds.has(b.id)),
  ]
  return {
    matched,
    remainingBase: carryBase,
    remainingHead: [...nonDroppedHead, ...carryHead],
  }
}

function lastNameSegment(qname: string): string {
  const staticIdx = qname.indexOf("::")
  if (staticIdx >= 0) return qname.slice(staticIdx + 2)
  const lastDot = qname.lastIndexOf(".")
  if (lastDot >= 0) return qname.slice(lastDot + 1)
  return qname
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}
