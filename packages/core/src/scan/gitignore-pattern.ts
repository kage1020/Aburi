// Rules and paths are matched as bytes, one character per byte, because git matches them so: `?`
// takes one byte of a UTF-8 name, not one character.

/** `"none"` is a directory with no opinion, which a deeper or shallower one may still supply. */
export type Verdict = "none" | "ignored" | "kept"

export interface GitignoreRules {
  decide(relative: string, isDirectory: boolean): Verdict
}

export interface RuleTooLong {
  readonly kind: "rule-too-long"
  /** 1-based. */
  readonly line: number
  /** The rule decoded as UTF-8. */
  readonly text: string
  readonly byteLength: number
}

// Each run of `*` can take the matcher one call deeper. A fixed cap keeps the deepest rule within
// the stack, so whether a rule can be decided never depends on the machine.
export const MAX_RULE_LENGTH = 4096

interface Rule {
  negative: boolean
  directoryOnly: boolean
  basenameOnly: boolean
  pattern: string
  /** What precedes the first glob character, compared as plain bytes. Path rules only. */
  head: string
}

const UTF8_BOM_AS_LATIN1 = "\xef\xbb\xbf"

export function parseGitignore(content: Buffer): GitignoreRules | RuleTooLong {
  let text = content.toString("latin1")
  if (text.startsWith(UTF8_BOM_AS_LATIN1)) text = text.slice(UTF8_BOM_AS_LATIN1.length)
  const rules: Rule[] = []
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw === "" || raw.startsWith("#")) continue
    const bytes = trimTrailingSpaces(cutAtNul(raw.endsWith("\r") ? raw.slice(0, -1) : raw))
    if (bytes.length > MAX_RULE_LENGTH) {
      return {
        kind: "rule-too-long",
        line: index + 1,
        text: Buffer.from(bytes, "latin1").toString("utf8"),
        byteLength: bytes.length,
      }
    }
    const rule = compileRule(bytes)
    if (rule !== null) rules.push(rule)
  }
  return {
    decide(relative: string, isDirectory: boolean): Verdict {
      const path = Buffer.from(relative, "utf8").toString("latin1")
      const basename = path.slice(path.lastIndexOf("/") + 1)
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i]
        if (rule === undefined || (rule.directoryOnly && !isDirectory)) continue
        const matched = rule.basenameOnly
          ? dowild(rule.pattern, 0, basename, 0, false) === MATCH
          : matchPathname(path, rule)
        if (matched) return rule.negative ? "kept" : "ignored"
      }
      return "none"
    },
  }
}

// Git reads each rule as a C string.
function cutAtNul(line: string): string {
  const nul = line.indexOf("\0")
  return nul < 0 ? line : line.slice(0, nul)
}

function trimTrailingSpaces(line: string): string {
  let lastSpace = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === " ") {
      if (lastSpace < 0) lastSpace = i
    } else {
      if (c === "\\") {
        i++
        if (i >= line.length) return line
      }
      lastSpace = -1
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace)
}

/** `null` for a rule git reads but that can match nothing (`!`, `a\`, `a[b`, `[[:nope:]]`). */
function compileRule(bytes: string): Rule | null {
  let pattern = bytes
  const negative = pattern.startsWith("!")
  if (negative) pattern = pattern.slice(1)
  const directoryOnly = pattern.endsWith("/")
  if (directoryOnly) pattern = pattern.slice(0, -1)
  const basenameOnly = !pattern.includes("/")
  if (!basenameOnly && pattern.startsWith("/")) pattern = pattern.slice(1)
  if (!canMatch(pattern)) return null
  const glob = pattern.search(/[*?[\\]/)
  const head = basenameOnly ? "" : glob < 0 ? pattern : pattern.slice(0, glob)
  return { negative, directoryOnly, basenameOnly, pattern, head }
}

function canMatch(pattern: string): boolean {
  if (pattern === "") return false
  for (let p = 0; p < pattern.length; p++) {
    const c = pattern.charCodeAt(p)
    if (c === BACKSLASH) {
      p++
      if (p >= pattern.length) return false
    } else if (c === OPEN) {
      const bracket = matchBracket(pattern, p, -1)
      if (bracket === null) return false
      p = bracket.end
    }
  }
  return true
}

function matchPathname(path: string, rule: Rule): boolean {
  const { pattern, head } = rule
  if (!path.startsWith(head)) return false
  if (head.length === pattern.length) return path.length === head.length
  // Git hands the glob the head's last byte too, so a `**` right after the head does not start a
  // directory.
  const kept = Math.max(0, head.length - 1)
  return dowild(pattern, kept, path, kept, true) === MATCH
}

const MATCH = 0
const NOMATCH = 1
const ABORT_ALL = -1
const ABORT_TO_STARSTAR = -2
type Outcome = typeof MATCH | typeof NOMATCH | typeof ABORT_ALL | typeof ABORT_TO_STARSTAR

const BANG = 0x21
const STAR = 0x2a
const DASH = 0x2d
const SLASH = 0x2f
const COLON = 0x3a
const QUESTION = 0x3f
const OPEN = 0x5b
const BACKSLASH = 0x5c
const CLOSE = 0x5d
const CARET = 0x5e

/** The byte at `i`, or 0 past the end: the C string's terminator, which neither side contains. */
function at(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0
}

function isGlobSpecial(c: number): boolean {
  return c === STAR || c === QUESTION || c === OPEN || c === BACKSLASH
}

// A port of `dowild` in git's wildmatch.c, case-sensitive. `start` is where this call's pattern
// begins, which decides whether a `**` there opens a directory.
function dowild(
  pattern: string,
  start: number,
  text: string,
  from: number,
  pathname: boolean,
): Outcome {
  let t = from
  for (let p = start; p < pattern.length; t++, p++) {
    let pCh = pattern.charCodeAt(p)
    let tCh = at(text, t)
    if (tCh === 0 && pCh !== STAR) return ABORT_ALL
    if (pCh === QUESTION) {
      if (pathname && tCh === SLASH) return NOMATCH
      continue
    }
    if (pCh === OPEN) {
      const bracket = matchBracket(pattern, p, tCh)
      if (bracket === null) return ABORT_ALL
      if (!bracket.matched || (pathname && tCh === SLASH)) return NOMATCH
      p = bracket.end
      continue
    }
    if (pCh !== STAR) {
      if (pCh === BACKSLASH) {
        p++
        pCh = at(pattern, p)
      }
      if (tCh !== pCh) return NOMATCH
      continue
    }

    let matchSlash: boolean
    p++
    if (at(pattern, p) === STAR) {
      const prevP = p
      do p++
      while (at(pattern, p) === STAR)
      const after = at(pattern, p)
      if (!pathname) {
        matchSlash = true
      } else if (
        (prevP - start < 2 || at(pattern, prevP - 2) === SLASH) &&
        (after === 0 || after === SLASH || (after === BACKSLASH && at(pattern, p + 1) === SLASH))
      ) {
        if (after === SLASH) {
          const zero = dowild(pattern, p + 1, text, t, pathname)
          // Git goes on to deeper directories after ABORT_ALL here. None of them can match, and
          // trying them costs time exponential in the number of `**/`.
          if (zero === MATCH || zero === ABORT_ALL) return zero
        }
        matchSlash = true
      } else {
        matchSlash = false
      }
    } else {
      matchSlash = !pathname
    }

    const next = at(pattern, p)
    if (next === 0) {
      return !matchSlash && text.includes("/", t) ? ABORT_TO_STARSTAR : MATCH
    }
    if (!matchSlash && next === SLASH) {
      const slash = text.indexOf("/", t)
      if (slash < 0) return ABORT_ALL
      t = slash
      continue
    }
    while (tCh !== 0) {
      if (!isGlobSpecial(next)) {
        for (;;) {
          tCh = at(text, t)
          if (tCh === 0 || tCh === next || (!matchSlash && tCh === SLASH)) break
          t++
        }
        if (tCh !== next) return matchSlash ? ABORT_ALL : ABORT_TO_STARSTAR
      }
      const matched = dowild(pattern, p, text, t, pathname)
      if (matched !== NOMATCH) {
        if (!matchSlash || matched !== ABORT_TO_STARSTAR) return matched
      } else if (!matchSlash && tCh === SLASH) {
        return ABORT_TO_STARSTAR
      }
      t++
      tCh = at(text, t)
    }
    return ABORT_ALL
  }
  return t < text.length ? NOMATCH : MATCH
}

/** `end` is the closing `]`, and `matched` already allows for `!`; `null` where git aborts. */
function matchBracket(
  pattern: string,
  open: number,
  tCh: number,
): { end: number; matched: boolean } | null {
  let p = open + 1
  let pCh = at(pattern, p)
  const negated = pCh === BANG || pCh === CARET
  if (negated) {
    p++
    pCh = at(pattern, p)
  }
  let prevCh = 0
  let matched = false
  do {
    if (pCh === 0) return null
    if (pCh === BACKSLASH) {
      p++
      pCh = at(pattern, p)
      if (pCh === 0) return null
      if (tCh === pCh) matched = true
    } else if (
      pCh === DASH &&
      prevCh !== 0 &&
      at(pattern, p + 1) !== 0 &&
      at(pattern, p + 1) !== CLOSE
    ) {
      p++
      pCh = at(pattern, p)
      if (pCh === BACKSLASH) {
        p++
        pCh = at(pattern, p)
        if (pCh === 0) return null
      }
      if (tCh <= pCh && tCh >= prevCh) matched = true
      pCh = 0
    } else if (pCh === OPEN && at(pattern, p + 1) === COLON) {
      const nameStart = p + 2
      let close = nameStart
      while (close < pattern.length && pattern.charCodeAt(close) !== CLOSE) close++
      if (close >= pattern.length) return null
      if (close === nameStart || at(pattern, close - 1) !== COLON) {
        if (tCh === OPEN) matched = true
      } else {
        const inClass = POSIX_CLASSES.get(pattern.slice(nameStart, close - 1))
        if (inClass === undefined) return null
        if (inClass(tCh)) matched = true
        p = close
        pCh = 0
      }
    } else if (tCh === pCh) {
      matched = true
    }
    prevCh = pCh
    p++
    pCh = at(pattern, p)
  } while (pCh !== CLOSE)
  return { end: p, matched: matched !== negated }
}

function within(c: number, low: string, high: string): boolean {
  return c >= low.charCodeAt(0) && c <= high.charCodeAt(0)
}

// Git's own ctype table rather than the C library's: ASCII whatever the locale, and no \v or \f in
// `space`.
const POSIX_CLASSES: ReadonlyMap<string, (c: number) => boolean> = new Map([
  ["alnum", (c: number) => within(c, "0", "9") || within(c, "A", "Z") || within(c, "a", "z")],
  ["alpha", (c: number) => within(c, "A", "Z") || within(c, "a", "z")],
  ["blank", (c: number) => c === 0x20 || c === 0x09],
  ["cntrl", (c: number) => (c >= 0 && c <= 0x1f) || c === 0x7f],
  ["digit", (c: number) => within(c, "0", "9")],
  ["graph", (c: number) => c >= 0x21 && c <= 0x7e],
  ["lower", (c: number) => within(c, "a", "z")],
  ["print", (c: number) => c >= 0x20 && c <= 0x7e],
  [
    "punct",
    (c: number) =>
      within(c, "!", "/") || within(c, ":", "@") || within(c, "[", "`") || within(c, "{", "~"),
  ],
  ["space", (c: number) => c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20],
  ["upper", (c: number) => within(c, "A", "Z")],
  ["xdigit", (c: number) => within(c, "0", "9") || within(c, "A", "F") || within(c, "a", "f")],
])
