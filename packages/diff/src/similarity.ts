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
 * owner cannot do what R-8 asks. `UserRepo.findById` and `AdminRepo.findById` agree on their
 * member name and their signature, so a shared `Repo` token at weight 0.2 carries them to
 * 0.8667 against a 0.85 threshold — while `UsersRepository.findById`, which *is* the rename,
 * shares no owner token and scores 0.8000. The collision outscores the rename, and raising the
 * weight only moves both: at 0.3 two three-token class names sharing two tokens land on
 * exactly 0.85.
 *
 * Owner extraction:
 * - `Class::method` → `Class`
 * - `A.B.C.method` → `A.B.C`
 * - `topLevel`     → `` (empty)
 *
 * Two empty owners are compatible: top-level Symbols share the one outer scope. One empty and
 * one not are never compatible — the two live at different depths.
 *
 * Otherwise the owners must correspond segment for segment, and within a segment every token
 * on each side must find a distinct partner on the other under `sameWord`. Both sides must be
 * covered, so `UserRepo` and `UserRepoV2` are two classes rather than one renamed — an added
 * token is as much evidence of a sibling as of a rename, and R-8's business is refusing the
 * collision.
 */
export function ownersAreCompatible(baseName: string, headName: string): boolean {
  return ownerGate(tokenizeEveryTime, baseName, headName)
}

/**
 * §3.4.6 — the tokens `a` and `b` name the same thing.
 *
 * Equal, or the same word inflected: `user`/`users`, `entity`/`entities`. Nothing else, and
 * that is the whole of the rule rather than a first approximation.
 *
 * A bare prefix test is the obvious generalisation and it cannot be made to work. It admits
 * `repo`/`report`, `cache`/`cached`, `con`/`controller` — two distinct classes, which is
 * exactly the collision R-8 exists to refuse. Every measure that might separate those from a
 * real rename fails, because the two populations interleave rather than sitting on opposite
 * sides of anything:
 *
 * ```
 *                              dice    levenshtein
 *   accept  UserRepo/UsersRepository   0.571   7
 *   reject  RepoManager/ReportManager  0.818   2
 *   accept  Repo/Repository            0.500   6
 *   reject  CacheStore/CachedStore     0.842   1
 * ```
 *
 * The renames to accept score *lower* than the collisions to refuse, on both. There is no
 * threshold, and a length-growth rule fares no better: `con`→`controller` grows by 7 and
 * `user`→`users` by 1, so anything admitting the second admits the first.
 *
 * Inflection is not on that spectrum. It is a closed, mechanical relation between two spellings
 * of one word, so it can be recognised rather than estimated — and it covers the case a plain
 * equality test misses most often, a class pluralised in place.
 *
 * What this gives up is the abbreviation family: `UserRepo` → `UsersRepository` no longer
 * clears the gate on `repo`/`repository`. That is a real rename reported as `added` +
 * `removed`, and §3.4.6 records it as the price of refusing `repo`/`report`, which no rule
 * over the two strings alone can tell apart. The evidence that would settle it is not in the
 * strings: the owner is itself a Symbol, and whether *it* paired is the question being
 * guessed at here.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return pluralises(short, long)
}

/**
 * The longest owner segment the matching will search.
 *
 * `augment` is Kuhn's, so the search is cubic in the token count and recursive with it. A
 * class name is a handful of words; anything past this is not a name the gate has an opinion
 * about, and `buildDiff` takes IR JSON from a caller rather than only from `aburi scan`, so
 * the bound is what turns an adversarial 1600-token identifier from a hang into an answer.
 * Refusing is the safe direction: the pair falls to `added` + `removed`.
 */
const MAX_OWNER_SEGMENT_TOKENS = 32

/** English noun inflection, which is what a pluralised class name goes through. */
function pluralises(singular: string, plural: string): boolean {
  if (plural === `${singular}s` || plural === `${singular}es`) return true
  return singular.endsWith("y") && plural === `${singular.slice(0, -1)}ies`
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
  // The common case, and the one a bucket of methods on one class hits every time.
  if (baseOwner === headOwner) return true
  return segmentsCorrespond(baseOwner, headOwner, setOf)
}

/**
 * §3.4.6 — the two owners name the same scope: segment for segment, token for token.
 *
 * Compared per segment rather than over the owner as a whole, because `tokenizeName` dedups
 * and an owner is a *path*. `Users.UserRepo` collapses to `{users, user, repo}` while
 * `Users.UsersRepository` collapses to `{users, repository}` — the namespace and the class
 * share a word, so one side loses a token and the two stop being comparable before any
 * spelling is looked at. Segment by segment they line up: `Users`/`Users`, then
 * `UserRepo`/`UsersRepository`.
 *
 * A rename changes what a class is called, not how deeply it is nested, so a differing segment
 * count is a differing scope.
 */
function segmentsCorrespond(baseOwner: string, headOwner: string, setOf: TokenSetOf): boolean {
  const baseSegments = baseOwner.split(".")
  const headSegments = headOwner.split(".")
  if (baseSegments.length !== headSegments.length) return false
  return baseSegments.every((segment, index) => {
    const counterpart = headSegments[index]
    if (counterpart === undefined) return false
    if (segment === counterpart) return true
    return coversBothWays(setOf(segment), setOf(counterpart))
  })
}

/**
 * Whether the two token sets admit a perfect matching under `sameWord`.
 *
 * Sizes must agree, after which an injection from one side is a bijection — so only one
 * direction is searched. The search is augmenting-path rather than greedy, because a greedy
 * pass can strand a token a different choice would have matched: over `{user, users}` and
 * `{user, userx}`, taking the identical pair first leaves `users` with nothing, though
 * `user`→`userx` with `users`→`user` covers both. One segment runs to a handful of tokens, so
 * the exact answer costs nothing worth saving.
 */
function coversBothWays(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  if (a.size > MAX_OWNER_SEGMENT_TOKENS) return false
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
    if (visited.has(candidate) || !sameWord(token, candidate)) continue
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
