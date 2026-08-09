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
 *
 * **The camel boundary is ASCII.** `isCamelBoundary` compares code points against `a`–`z`,
 * `A`–`Z` and `0`–`9`, so a name written in a script with no ASCII case boundary and no
 * separator comes back whole: `获取用户信息` and `ユーザー情報を取得する` are one token each,
 * and so is `получитьПользователя` — its camel hump does not register. A separator still
 * splits (`ユーザー.取得` gives two), and a mixed name splits on its ASCII half.
 *
 * That makes the token count a poor measure of how much such a name says, which matters
 * wherever a count is read as a proxy for that — see §3.4.3's admissibility rule.
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
 * §3.4.1 — Jaccard over the tokens of the **last segment**: the member name with its owner
 * removed. What §3.4's composite reads, because §3.4.6 decides the owner separately and
 * reading it on both axes charges for it twice.
 */
export function memberSimilarity(baseName: string, headName: string): number {
  return memberFormula(tokenizeEveryTime, baseName, headName)
}

/**
 * §3.4.6 (R-8) — whether two Symbols are close enough in *scope* to be the same Symbol: the
 * same owner, or one whose owner was renamed. A gate rather than a score, because grading the
 * owner cannot do what R-8 asks. `UserRepo.getUser` and `AdminRepo.getUser` agree on their
 * member name and their signature, so at any weight small enough to leave the name axis
 * meaning something, a shared `Repo` token carries them over the threshold — while
 * `UsersRepository`, which *is* the rename, shares no token at all and scores below them.
 *
 * Owner extraction:
 * - `Class::method` → `Class`
 * - `A.B.C.method` → `A.B.C`
 * - `topLevel`     → `` (empty)
 *
 * Two empty owners are compatible: top-level Symbols share the one outer scope. One empty and
 * one not are never compatible — the two live at different depths.
 *
 * Otherwise every token on each side must find a distinct partner on the other, where a
 * partner is the same token or one it abbreviates: `repo`/`repository`, `user`/`users`. Both
 * sides must be covered, so `UserRepo` and `UserRepoV2` are two classes rather than one
 * renamed — an added token is as much evidence of a sibling as of a rename, and R-8's business
 * is refusing the collision.
 */
export function ownersAreCompatible(baseName: string, headName: string): boolean {
  return ownerGate(tokenizeEveryTime, baseName, headName)
}

/**
 * The shortest prefix that counts as an abbreviation. Two characters match far too much to be
 * evidence — `id` opens `identity`, `identifier` and `idempotent` alike — so `IdMap` and
 * `IdentityMap` are left unpaired rather than guessed at.
 */
const MIN_ABBREVIATION = 3

function abbreviates(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= MIN_ABBREVIATION && long.startsWith(short)
}

function nameFormula(setOf: TokenSetOf, baseName: string, headName: string): number {
  return jaccardSets(setOf(baseName), setOf(headName))
}

function memberFormula(setOf: TokenSetOf, baseName: string, headName: string): number {
  return jaccardSets(setOf(lastSegment(baseName)), setOf(lastSegment(headName)))
}

function ownerGate(setOf: TokenSetOf, baseName: string, headName: string): boolean {
  const baseOwner = extractOwner(baseName)
  const headOwner = extractOwner(headName)
  if (baseOwner === "" && headOwner === "") return true
  if (baseOwner === "" || headOwner === "") return false
  return coversBothWays(setOf(baseOwner), setOf(headOwner))
}

/**
 * Whether the two token sets admit a perfect matching under `abbreviates`.
 *
 * Sizes must agree, after which an injection from one side is a bijection — so only one
 * direction is searched. The search is augmenting-path rather than greedy, because a greedy
 * pass can strand a token a different choice would have matched: over `{user, users}` and
 * `{user, userx}`, taking the identical pair first leaves `users` with nothing, though
 * `user`→`userx` with `users`→`user` covers both. Owners run to a handful of tokens, so the
 * exact answer costs nothing worth saving.
 */
function coversBothWays(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  const right = [...b]
  const partnerOf = new Map<string, string>()
  for (const token of a) {
    if (!augment(token, right, partnerOf, new Set())) return false
  }
  return true
}

/** Kuhn's step: claim a free partner for `token`, or displace one that can move on. */
function augment(
  token: string,
  right: readonly string[],
  partnerOf: Map<string, string>,
  visited: Set<string>,
): boolean {
  for (const candidate of right) {
    if (visited.has(candidate) || !abbreviates(token, candidate)) continue
    visited.add(candidate)
    const holder = partnerOf.get(candidate)
    if (holder === undefined || augment(holder, right, partnerOf, visited)) {
      partnerOf.set(candidate, token)
      return true
    }
  }
  return false
}

/** The formulas §3.4 reads, over a token table shared for one matching pass. */
export interface NameScorer {
  name(baseName: string, headName: string): number
  member(baseName: string, headName: string): number
  ownersCompatible(baseName: string, headName: string): boolean
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
    member: (baseName, headName) => memberFormula(setOf, baseName, headName),
    ownersCompatible: (baseName, headName) => ownerGate(setOf, baseName, headName),
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
