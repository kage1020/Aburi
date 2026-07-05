/**
 * String similarity utilities dedicated to the diff engine. Kept in one file so the
 * name/signature/owner formulas are auditable side by side against diff-algorithm.md §3.4.
 */

/**
 * Tokenise a qualified name into normalised lowercase word segments. Splits on:
 * - camelCase / PascalCase boundaries (`fooBar` → `foo`, `Bar`)
 * - snake_case underscores (`foo_bar` → `foo`, `bar`)
 * - dotted namespaces (`ns.Class` → `ns`, `Class`)
 * - `::` static-method separator (`Class::method` → `Class`, `method`)
 * - runs of digits (`get2Users` → `get`, `2`, `Users`)
 *
 * The result is de-duplicated so `InvoiceService.createInvoice` collapses to
 * `["invoice", "service", "create"]` — Jaccard similarity relies on set semantics, so
 * repeated tokens must not double-count.
 */
export function tokenizeName(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.split(/[.:_\-\s/]+/)) {
    if (raw.length === 0) continue
    for (const piece of splitCamel(raw)) {
      const norm = piece.toLowerCase()
      if (norm.length === 0 || seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

function splitCamel(word: string): string[] {
  const chunks: string[] = []
  let current = ""
  for (const ch of word) {
    if (current === "") {
      current = ch
      continue
    }
    const prev = current.slice(-1)
    const boundary = isCamelBoundary(prev, ch)
    if (boundary) {
      chunks.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function isCamelBoundary(prev: string, curr: string): boolean {
  const prevLower = prev >= "a" && prev <= "z"
  const prevUpper = prev >= "A" && prev <= "Z"
  const prevDigit = prev >= "0" && prev <= "9"
  const currLower = curr >= "a" && curr <= "z"
  const currUpper = curr >= "A" && curr <= "Z"
  const currDigit = curr >= "0" && curr <= "9"
  if (prevLower && currUpper) return true
  if ((prevLower || prevUpper) && currDigit) return true
  if (prevDigit && (currLower || currUpper)) return true
  return false
}

/**
 * Jaccard similarity between two token multisets. Formula: |A ∩ B| / |A ∪ B|.
 * Empty on both sides returns 1.0 (both are "no tokens", which are equivalent for the
 * purpose of §3.4.1). Empty on one side only returns 0.0.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return intersection / union
}

/** name-token Jaccard shortcut used by nameSimilarity and ownerSimilarity call sites. */
export function jaccardTokens(a: string, b: string): number {
  return jaccard(tokenizeName(a), tokenizeName(b))
}

/**
 * §3.4.1 — Jaccard over the tokens of the full qualified name. The last segment is not
 * given extra weight; the entire path contributes uniformly because the intersection is
 * what the score should reward.
 */
export function nameSimilarity(baseName: string, headName: string): number {
  return jaccardTokens(baseName, headName)
}

/**
 * §3.4.6 — owner similarity: same as nameSimilarity but restricted to everything **before**
 * the last segment. Compensates for the R-8 same-name-different-class collision, where
 * `UserRepo.getUser` should not be pair-swapped with `AdminRepo.getUser`.
 *
 * Owner extraction:
 * - `Class::method` → `Class`
 * - `A.B.C.method` → `A.B.C`
 * - `topLevel`     → `` (empty)
 *
 * When both owners are empty (top-level functions), returns 1.0 because both live in the
 * same "no-owner" bucket. When one is empty and the other is not, returns 0.0 because the
 * two Symbols live in structurally different scopes.
 */
export function ownerSimilarity(baseName: string, headName: string): number {
  const baseOwner = extractOwner(baseName)
  const headOwner = extractOwner(headName)
  if (baseOwner === "" && headOwner === "") return 1
  if (baseOwner === "" || headOwner === "") return 0
  return jaccardTokens(baseOwner, headOwner)
}

function extractOwner(qname: string): string {
  const staticIdx = qname.indexOf("::")
  if (staticIdx >= 0) return qname.slice(0, staticIdx)
  const lastDot = qname.lastIndexOf(".")
  if (lastDot >= 0) return qname.slice(0, lastDot)
  return ""
}

/** §3.4.1 tail note — used by drop-4.5 weak matcher and threshold lookup. */
export function lastSegment(qname: string): string {
  const staticIdx = qname.indexOf("::")
  if (staticIdx >= 0) return qname.slice(staticIdx + 2)
  const lastDot = qname.lastIndexOf(".")
  if (lastDot >= 0) return qname.slice(lastDot + 1)
  return qname
}
