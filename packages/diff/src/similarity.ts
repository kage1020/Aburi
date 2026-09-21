/**
 * String similarity utilities dedicated to the diff engine. Kept in one file so the
 * name/signature/owner formulas are auditable side by side against diff-algorithm.md.
 */

/**
 * Tokenise a qualified name into de-duplicated lowercase word segments, splitting on camel /
 * Pascal boundaries, `_`, `.`, `::` and digit runs: `InvoiceService.createInvoice` →
 * `["invoice", "service", "create"]`. De-duplicated because Jaccard relies on set semantics.
 *
 * The camel boundary is Unicode case, not the ASCII ranges, so `получитьПользователя` splits
 * at its hump the way `getUser` does. What no case rule can split is a script that has no
 * case at all: `ユーザー情報を取得する` and `获取用户信息` come back whole however much they
 * say. That is a fact about the writing system rather than about the name, which is why the
 * token count is not what diff-algorithm.md §3.4.3 asks how much a name says — see
 * `nameEvidence`.
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
    if (isCamelBoundary(current.slice(-1), ch)) {
      chunks.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const LOWER = /\p{Ll}/u
const UPPER = /\p{Lu}|\p{Lt}/u
const DIGIT = /\p{Nd}/u

/**
 * Unicode case rather than the ASCII ranges, so a hump is a hump in every cased script:
 * `получитьПользователя` splits into two the way `getUser` does. Titlecase counts as upper,
 * for the digraphs that carry it (`ǅ`), since it opens a word exactly as an uppercase letter
 * would. A script with no case reaches none of these arms and is left whole, which is the
 * right answer — there is no boundary in it to find.
 */
function isCamelBoundary(prev: string, curr: string): boolean {
  const prevLower = LOWER.test(prev)
  const prevUpper = UPPER.test(prev)
  const prevDigit = DIGIT.test(prev)
  const currLower = LOWER.test(curr)
  const currUpper = UPPER.test(curr)
  const currDigit = DIGIT.test(curr)
  if (prevLower && currUpper) return true
  if ((prevLower || prevUpper) && currDigit) return true
  if (prevDigit && (currLower || currUpper)) return true
  return false
}

/**
 * Characters that are a morpheme on their own, so that a run of them is several words with
 * nothing between them to split on. Han, the two kana, and Hangul syllables.
 *
 * `Script_Extensions` rather than `Script`, so the marks that belong to a run without being
 * of its script come with it — U+30FC, the prolonged sound mark in `ユーザー`, is `Common`
 * under `Script` and would otherwise read as foreign to the word it is part of.
 *
 * An alphabetic script with no case — Arabic, Hebrew, Thai — is deliberately not here. Its
 * characters are letters, not morphemes, so a run of them is one word and the token count is
 * already right about it; a multi-word identifier in those scripts separates its words, and
 * `tokenizeName` splits on the separator.
 */
const MORPHEMIC = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u

/**
 * How much a qualified name says, in units of "one thing named".
 *
 * The distinct-token count is this number for every name the tokeniser can segment, and every
 * caller wanting *granularity* — how coarse a Jaccard over these tokens will be — should keep
 * reading that count instead. This answers the different question diff-algorithm.md §3.4.3
 * asks: could two unrelated Symbols carry this name by coincidence? One word could be carried
 * twice; a phrase could not.
 *
 * A token of a cased or alphabetic script is one word, so it is worth 1 — `main`, `handler`
 * and `initialize` alike, however long they run, because length is not what makes a word
 * coincidental. A token of a morphemic script carries a word per character with no boundary
 * written between them, so each of those characters is worth 1: `获取用户信息` is six, which
 * is what it says, and is no more a coincidence than `getUserInformation`. Any remainder of a
 * mixed token is worth 1 between them.
 */
export function nameEvidence(qname: string): number {
  let total = 0
  for (const token of tokenizeName(qname)) {
    let morphemic = 0
    let rest = false
    for (const ch of token) {
      if (MORPHEMIC.test(ch)) morphemic++
      else rest = true
    }
    total += morphemic + (rest ? 1 : 0)
  }
  return total
}

/**
 * Jaccard similarity |A ∩ B| / |A ∪ B| over two token lists. Empty on both sides is 1.0
 * (both are "no tokens", equivalent for nameSimilarity); empty on one side only is 0.0.
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

/** Jaccard over the tokens of two strings. Public surface only; nothing in this file calls it. */
export function jaccardTokens(a: string, b: string): number {
  return jaccard(tokenizeName(a), tokenizeName(b))
}

/** A qualified name split at its last `.` or its `::`; a top-level name has an empty owner. */
function splitQualifiedName(qname: string): { owner: string; member: string } {
  const staticIdx = qname.indexOf("::")
  if (staticIdx >= 0)
    return { owner: qname.slice(0, staticIdx), member: qname.slice(staticIdx + 2) }
  const lastDot = qname.lastIndexOf(".")
  if (lastDot >= 0) return { owner: qname.slice(0, lastDot), member: qname.slice(lastDot + 1) }
  return { owner: "", member: qname }
}

/** The member name; read by the weak matcher and the threshold lookup. */
export function lastSegment(qname: string): string {
  return splitQualifiedName(qname).member
}

/** Looks up the token set of a name. `createNameScorer` memoises it; the plain functions do not. */
type TokenSets = (value: string) => ReadonlySet<string>

const uncachedTokenSets: TokenSets = (value) => new Set(tokenizeName(value))

/** Jaccard over the tokens of the full qualified name, every segment weighted alike. */
export function nameSimilarity(baseName: string, headName: string): number {
  return nameJaccard(uncachedTokenSets, baseName, headName)
}

/**
 * Jaccard over the tokens of the **last segment** only. What stage 4's composite reads, because the
 * owner gate decides the owner separately and reading it on both axes charges twice.
 */
export function memberSimilarity(baseName: string, headName: string): number {
  return memberJaccard(uncachedTokenSets, baseName, headName)
}

/**
 * The owner gate (diff-algorithm.md, R-8) — whether two Symbols are close enough in *scope* to be
 * the same Symbol: the same owner, or one whose owner was renamed. A gate rather than a score,
 * because grading the owner cannot do what R-8 asks. `UserRepo.findById` and `AdminRepo.findById`
 * agree on their member name and their signature, so a shared `Repo` token at weight 0.2 carries
 * them to 0.8667 against a 0.85 threshold — while `UsersRepository.findById`, which *is* the
 * rename, shares no owner token and scores 0.8000. The collision outscores the rename, and
 * raising the weight only moves both: at 0.3 two three-token class names sharing two tokens land
 * on exactly 0.85.
 *
 * Two empty owners are compatible (top-level Symbols share the outer scope); one empty and one
 * not never are. Otherwise the owners must correspond segment for segment, every token on each
 * side finding a distinct partner under `sameWord`.
 */
export function ownersAreCompatible(baseName: string, headName: string): boolean {
  return ownersCompatible(
    splitQualifiedName(baseName).owner,
    splitQualifiedName(headName).owner,
    uncachedTokenSets,
  )
}

/**
 * The tokens `a` and `b` name the same thing: equal, or the same word inflected
 * (`user`/`users`, `entity`/`entities`). Nothing else. A prefix or edit-distance rule admits
 * `repo`/`report` and `cache`/`cached` — the collisions R-8 exists to refuse — and no
 * threshold separates those from real renames; diff-algorithm.md has the figures and
 * records the abbreviation family (`Repo` → `Repository`) as the price.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return pluralises(short, long)
}

/**
 * The longest owner segment the matching will search. `augment` is Kuhn's — cubic and
 * recursive in the token count — and `buildDiff` takes IR JSON from any caller, so the bound
 * turns an adversarial 1600-token identifier from a hang into a refusal (added + removed).
 */
const MAX_OWNER_SEGMENT_TOKENS = 32

/** English noun inflection, which is what a pluralised class name goes through. */
function pluralises(singular: string, plural: string): boolean {
  if (plural === `${singular}s` || plural === `${singular}es`) return true
  return singular.endsWith("y") && plural === `${singular.slice(0, -1)}ies`
}

function nameJaccard(tokenSets: TokenSets, baseName: string, headName: string): number {
  return jaccardSets(tokenSets(baseName), tokenSets(headName))
}

function memberJaccard(tokenSets: TokenSets, baseName: string, headName: string): number {
  return jaccardSets(tokenSets(lastSegment(baseName)), tokenSets(lastSegment(headName)))
}

/**
 * The owner gate over two already-extracted owners. Identical owners answer on a string
 * compare, which a bucket of methods on one class hits every time; then a first-segment
 * filter refuses most of the rest before the full matching runs.
 */
function ownersCompatible(baseOwner: string, headOwner: string, tokenSets: TokenSets): boolean {
  if (baseOwner === headOwner) return true
  if (baseOwner === "" || headOwner === "") return false
  if (!firstSegmentsCouldAgree(baseOwner, headOwner, tokenSets)) return false
  return segmentsCorrespond(baseOwner, headOwner, tokenSets)
}

/**
 * The two owners name the same scope: segment for segment, token for token.
 * Per segment rather than over the owner as a whole, because `tokenizeName` dedups and an
 * owner is a *path*: `Users.UserRepo` and `Users.UsersRepository` lose a token to the shared
 * namespace when tokenised whole. A differing segment count is a differing scope.
 */
function segmentsCorrespond(baseOwner: string, headOwner: string, tokenSets: TokenSets): boolean {
  const baseSegments = baseOwner.split(".")
  const headSegments = headOwner.split(".")
  if (baseSegments.length !== headSegments.length) return false
  return baseSegments.every((segment, index) => {
    const counterpart = headSegments[index]
    if (counterpart === undefined) return false
    if (segment === counterpart) return true
    return hasPerfectTokenMatching(tokenSets(segment), tokenSets(counterpart))
  })
}

/**
 * Whether the two token sets admit a perfect matching under `sameWord`. Sizes must agree,
 * after which an injection is a bijection, so one direction is searched. Augmenting-path
 * rather than greedy: over `{user, users}` and `{user, userx}` a greedy pass takes the
 * identical pair first and strands `users`.
 */
function hasPerfectTokenMatching(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
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

/**
 * A necessary condition on two non-empty owners, cheaper than the full gate: their first
 * segments must correspond. A filter, not a decision — it relaxes the perfect matching to
 * "every token finds some partner", so it can only admit more than the gate does.
 */
function firstSegmentsCouldAgree(
  baseOwner: string,
  headOwner: string,
  tokenSets: TokenSets,
): boolean {
  const baseFirst = baseOwner.slice(0, dotOrEnd(baseOwner))
  const headFirst = headOwner.slice(0, dotOrEnd(headOwner))
  if (baseFirst === headFirst) return true
  const baseTokens = tokenSets(baseFirst)
  const headTokens = tokenSets(headFirst)
  if (baseTokens.size !== headTokens.size) return false
  // Still necessary at the ceiling, since the matching refuses a segment this wide outright;
  // refusing here keeps that an O(1) answer rather than an all-pairs scan ahead of it.
  if (baseTokens.size > MAX_OWNER_SEGMENT_TOKENS) return false
  for (const token of baseTokens) {
    let partnered = false
    for (const candidate of headTokens) {
      if (sameWord(token, candidate)) {
        partnered = true
        break
      }
    }
    if (!partnered) return false
  }
  return true
}

function dotOrEnd(owner: string): number {
  const dot = owner.indexOf(".")
  return dot < 0 ? owner.length : dot
}

/** The formulas stage 4 reads, over a token table shared for one matching pass. */
export interface NameScorer {
  name(baseName: string, headName: string): number
  member(baseName: string, headName: string): number
  ownersCompatible(baseName: string, headName: string): boolean
}

/**
 * A scorer that tokenises each distinct name once. Stage 4 asks K² similarities over 2K
 * distinct names per bucket, so tokenising per call re-splits the same strings hundreds of
 * thousands of times. Owners are memoised per name too; the pair is not, because a bulk
 * rename produces as many distinct owner pairs as candidates, enough to exceed V8's Map limit.
 */
export function createNameScorer(): NameScorer {
  const sets = new Map<string, ReadonlySet<string>>()
  const tokenSets: TokenSets = (value) => {
    const cached = sets.get(value)
    if (cached !== undefined) return cached
    const built: ReadonlySet<string> = new Set(tokenizeName(value))
    sets.set(value, built)
    return built
  }
  const owners = new Map<string, string>()
  const ownerOf = (qname: string): string => {
    const cached = owners.get(qname)
    if (cached !== undefined) return cached
    const built = splitQualifiedName(qname).owner
    owners.set(qname, built)
    return built
  }
  return {
    name: (baseName, headName) => nameJaccard(tokenSets, baseName, headName),
    member: (baseName, headName) => memberJaccard(tokenSets, baseName, headName),
    ownersCompatible: (baseName, headName) =>
      ownersCompatible(ownerOf(baseName), ownerOf(headName), tokenSets),
  }
}
