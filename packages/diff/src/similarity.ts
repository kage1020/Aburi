export function tokenizeName(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input.normalize("NFC").split(/[.:_\-\s/]+/)) {
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
  let prev = ""
  for (const ch of word) {
    if (current === "") {
      current = ch
      prev = ch
      continue
    }
    if (isCamelBoundary(prev, ch)) {
      chunks.push(current)
      current = ch
    } else {
      current += ch
    }
    prev = ch
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const LOWER = /\p{Ll}/u
const UPPER = /\p{Lu}|\p{Lt}/u
const DIGIT = /\p{Nd}/u

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

const HAN = /\p{scx=Han}/u
const SYLLABIC = /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u
const MARK = /\p{M}/u
const HAN_CHARS_PER_WORD = 3
const SYLLABIC_CHARS_PER_WORD = 6

export function nameEvidence(qname: string): number {
  const counted = new Set<string>()
  let han = 0
  let syllabic = 0
  let words = 0
  for (const token of tokenizeName(qname)) {
    let alphabetic = false
    for (const ch of token) {
      if (MARK.test(ch)) continue
      const isHan = HAN.test(ch)
      if (!isHan && !SYLLABIC.test(ch)) {
        alphabetic = true
        continue
      }
      if (counted.has(ch)) continue
      counted.add(ch)
      if (isHan) han++
      else syllabic++
    }
    if (alphabetic) words++
  }
  return words + han / HAN_CHARS_PER_WORD + syllabic / SYLLABIC_CHARS_PER_WORD
}

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

/** A qualified name split at its last separator, `.` or `::`; a top-level name has an empty owner. */
function splitQualifiedName(qname: string): { owner: string; member: string } {
  const lastStatic = qname.lastIndexOf("::")
  const lastDot = qname.lastIndexOf(".")
  if (lastStatic > lastDot)
    return { owner: qname.slice(0, lastStatic), member: qname.slice(lastStatic + 2) }
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

export function memberSimilarity(baseName: string, headName: string): number {
  return memberJaccard(uncachedTokenSets, baseName, headName)
}

export function ownersAreCompatible(baseName: string, headName: string): boolean {
  return ownersCompatible(
    splitQualifiedName(baseName).owner,
    splitQualifiedName(headName).owner,
    uncachedTokenSets,
  )
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return pluralises(short, long)
}

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

function ownersCompatible(baseOwner: string, headOwner: string, tokenSets: TokenSets): boolean {
  if (baseOwner === headOwner) return true
  if (baseOwner === "" || headOwner === "") return false
  if (!firstSegmentsCouldAgree(baseOwner, headOwner, tokenSets)) return false
  return segmentsCorrespond(baseOwner, headOwner, tokenSets)
}

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
