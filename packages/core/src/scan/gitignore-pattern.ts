// Rules and paths are matched as bytes, one character per byte, because git matches them so: `?`
// takes one byte of a UTF-8 name, not one character.

/** `"none"` is a directory with no opinion, which a deeper or shallower one may still supply. */
export type Verdict = "none" | "ignored" | "kept"

export interface GitignoreRules {
  decide(relative: string, isDirectory: boolean): Verdict
}

interface Rule {
  negative: boolean
  directoryOnly: boolean
  basenameOnly: boolean
  /** `null` for a rule git reads but that can match nothing (`a\`, `a[b`, `[[:nope:]]`). */
  regex: RegExp | null
}

export interface RuleLine {
  index: number
  bytes: string
}

const UTF8_BOM = "\xef\xbb\xbf"

export function readRuleLines(content: Buffer): RuleLine[] {
  let text = content.toString("latin1")
  if (text.startsWith(UTF8_BOM)) text = text.slice(UTF8_BOM.length)
  const out: RuleLine[] = []
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw === "" || raw.startsWith("#")) continue
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    out.push({ index, bytes: trimTrailingSpaces(line) })
  }
  return out
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

export function compileRules(lines: readonly RuleLine[]): GitignoreRules {
  const rules = lines.map((line) => compileRule(line.bytes))
  return {
    decide(relative: string, isDirectory: boolean): Verdict {
      const path = Buffer.from(relative, "utf8").toString("latin1")
      const basename = path.slice(path.lastIndexOf("/") + 1)
      for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i]
        if (rule === undefined || rule.regex === null) continue
        if (rule.directoryOnly && !isDirectory) continue
        if (rule.regex.test(rule.basenameOnly ? basename : path)) {
          return rule.negative ? "kept" : "ignored"
        }
      }
      return "none"
    },
  }
}

function compileRule(bytes: string): Rule {
  let pattern = bytes
  const negative = pattern.startsWith("!")
  if (negative) pattern = pattern.slice(1)
  const directoryOnly = pattern.endsWith("/")
  if (directoryOnly) pattern = pattern.slice(0, -1)
  const basenameOnly = !pattern.includes("/")
  let body: string | null
  if (basenameOnly) {
    body = compileGlob(pattern)
  } else {
    if (pattern.startsWith("/")) pattern = pattern.slice(1)
    // Git globs only what follows the literal head, so a `**` right after it counts as leading:
    // `a**/b` matches `a/x/b`. A basename rule gets no such split.
    const head = literalHeadLength(pattern)
    const rest = compileGlob(pattern.slice(head))
    body = rest === null ? null : literal(pattern.slice(0, head)) + rest
  }
  return {
    negative,
    directoryOnly,
    basenameOnly,
    regex: body === null ? null : new RegExp(`^${body}$`, "s"),
  }
}

function literalHeadLength(pattern: string): number {
  const found = pattern.search(/[*?[\\]/)
  return found < 0 ? pattern.length : found
}

/** `null` where git aborts the match, so the rule matches nothing. */
function compileGlob(pattern: string): string | null {
  let out = ""
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] as string
    if (c === "*") {
      let end = i
      while (pattern[end] === "*") end++
      const atBoundaryBefore = i === 0 || pattern[i - 1] === "/"
      const next = pattern[end]
      const atBoundaryAfter =
        next === undefined || next === "/" || (next === "\\" && pattern[end + 1] === "/")
      if (end - i >= 2 && atBoundaryBefore && atBoundaryAfter) {
        if (next === "/") {
          out += "(?:.*/)?"
          i = end + 1
        } else {
          out += ".*"
          i = end
        }
        continue
      }
      out += "[^/]*"
      i = end
      continue
    }
    if (c === "?") {
      out += "[^/]"
      i++
      continue
    }
    if (c === "\\") {
      const escaped = pattern[i + 1]
      if (escaped === undefined) return null
      out += literal(escaped)
      i += 2
      continue
    }
    if (c === "[") {
      const bracket = compileBracket(pattern, i)
      if (bracket === null) return null
      out += bracket.regex
      i = bracket.end
      continue
    }
    out += literal(c)
    i++
  }
  return out
}

function compileBracket(pattern: string, start: number): { regex: string; end: number } | null {
  let k = start + 1
  let negated = false
  if (pattern[k] === "!" || pattern[k] === "^") {
    negated = true
    k++
  }
  let members = ""
  let previous: string | null = null
  let ch = pattern[k]
  for (;;) {
    if (ch === undefined) return null
    if (ch === "\\") {
      k++
      ch = pattern[k]
      if (ch === undefined) return null
      members += classMember(ch)
    } else if (
      ch === "-" &&
      previous !== null &&
      k + 1 < pattern.length &&
      pattern[k + 1] !== "]"
    ) {
      k++
      let upper = pattern[k] as string
      if (upper === "\\") {
        k++
        const escaped = pattern[k]
        if (escaped === undefined) return null
        upper = escaped
      }
      if (previous <= upper) members += `${classMember(previous)}-${classMember(upper)}`
      ch = ""
    } else if (ch === "[" && pattern[k + 1] === ":") {
      const nameStart = k + 2
      let close = nameStart
      while (close < pattern.length && pattern[close] !== "]") close++
      if (close >= pattern.length) return null
      if (close === nameStart || pattern[close - 1] !== ":") {
        members += classMember("[")
      } else {
        const set = POSIX_CLASSES.get(pattern.slice(nameStart, close - 1))
        if (set === undefined) return null
        members += set
        k = close
        ch = ""
      }
    } else {
      members += classMember(ch)
    }
    previous = ch === "" ? null : ch
    k++
    ch = pattern[k]
    if (ch === "]") break
  }
  const regex = negated ? `[^/${members}]` : `(?!/)[${members}]`
  return { regex, end: k + 1 }
}

// Git's own ctype table rather than the C library's: ASCII whatever the locale, and no \v or \f in
// `space`.
const POSIX_CLASSES: ReadonlyMap<string, string> = new Map([
  ["alnum", "0-9A-Za-z"],
  ["alpha", "A-Za-z"],
  ["blank", " \\t"],
  ["cntrl", "\\x00-\\x1f\\x7f"],
  ["digit", "0-9"],
  ["graph", "\\x21-\\x7e"],
  ["lower", "a-z"],
  ["print", "\\x20-\\x7e"],
  ["punct", "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e"],
  ["space", "\\t\\n\\r "],
  ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"],
])

function literal(text: string): string {
  let out = ""
  for (const c of text) out += /[A-Za-z0-9_/]/.test(c) ? c : hexEscape(c)
  return out
}

function classMember(c: string): string {
  return /[A-Za-z0-9_]/.test(c) ? c : hexEscape(c)
}

function hexEscape(c: string): string {
  return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
}
