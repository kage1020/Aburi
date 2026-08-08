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
  return jaccardSets(new Set(a), new Set(b))
}

function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const token of small) if (large.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

/**
 * Jaccard over the tokens of two strings. Part of the module's surface rather than an
 * internal shortcut: the two formulas below go through a token table they share for one
 * matching pass, so this has no caller inside this file.
 */
export function jaccardTokens(a: string, b: string): number {
  return jaccard(tokenizeName(a), tokenizeName(b))
}

/** How a formula gets the token set of a name. The only thing the memo below changes. */
type TokenSetOf = (value: string) => ReadonlySet<string>

const tokenizeEveryTime: TokenSetOf = (value) => new Set(tokenizeName(value))

/**
 * §3.4.1 — Jaccard over the tokens of the full qualified name. The last segment is not
 * given extra weight; the entire path contributes uniformly because the intersection is
 * what the score should reward.
 */
export function nameSimilarity(baseName: string, headName: string): number {
  return nameFormula(tokenizeEveryTime, baseName, headName)
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
  return ownerFormula(tokenizeEveryTime, baseName, headName)
}

function nameFormula(setOf: TokenSetOf, baseName: string, headName: string): number {
  return jaccardSets(setOf(baseName), setOf(headName))
}

function ownerFormula(setOf: TokenSetOf, baseName: string, headName: string): number {
  const baseOwner = extractOwner(baseName)
  const headOwner = extractOwner(headName)
  if (baseOwner === "" && headOwner === "") return 1
  if (baseOwner === "" || headOwner === "") return 0
  return jaccardSets(setOf(baseOwner), setOf(headOwner))
}

/** The two similarity formulas of §3.4, over a token table shared for one matching pass. */
export interface NameScorer {
  name(baseName: string, headName: string): number
  owner(baseName: string, headName: string): number
}

/**
 * A scorer that tokenises each distinct name once.
 *
 * Stage 4 scores every (base, head) pair in a bucket, so a bucket of K on each side asks for
 * K² similarities over 2K distinct names — tokenising on every call splits the same strings
 * into the same tokens hundreds of thousands of times. The table lives for one call rather
 * than for the process, because the names it holds are only the ones that pass is comparing.
 */
export function createNameScorer(): NameScorer {
  const sets = new Map<string, ReadonlySet<string>>()
  const setOf: TokenSetOf = (value) => {
    const cached = sets.get(value)
    if (cached !== undefined) return cached
    const built: ReadonlySet<string> = new Set(tokenizeName(value))
    sets.set(value, built)
    return built
  }
  return {
    name: (baseName, headName) => nameFormula(setOf, baseName, headName),
    owner: (baseName, headName) => ownerFormula(setOf, baseName, headName),
  }
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
