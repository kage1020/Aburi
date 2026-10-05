/**
 * One `.gitignore`'s rules, read and matched the way git reads and matches them.
 *
 * Git's own matcher, not a library's reading of the documentation. The two differ in places a
 * workspace notices: `ignore` answers about a path by first walking its parents inside the one
 * file, so a deeper file re-including a directory never got a say about the files in it; it
 * reads `src/**\/` as matching the files directly in `src`, compiles a lone `!` into a negation
 * of everything, and has no POSIX classes, no escaped `?` and no `]` as a bracket's first
 * member. What git does is in `dir.c` (which lines are rules, and against what each is matched)
 * and `wildmatch.c` (the glob itself); the comments below name the behaviour each piece copies.
 *
 * Everything is matched as bytes, as git matches it: a path and a rule are both read as the
 * UTF-8 they are stored in, one character per byte. So `?` takes one byte, not one character,
 * and an `é` in a bracket is two members — which is git's answer, measured.
 */

/** What one file's rules say about one path. Silence is an answer the descent needs. */
export type Verdict = "none" | "ignored" | "kept"

/** One file's rules, in file order. */
export interface GitignoreRules {
  /**
   * The verdict of the last rule in the file that matches exactly `relative`, a path relative
   * to the file's own directory. Only the path itself: whether a parent directory is excluded is
   * the caller's question, answered across every file at once.
   */
  decide(relative: string, isDirectory: boolean): Verdict
}

interface Rule {
  negative: boolean
  /** A trailing `/`: the rule matches directories only. */
  directoryOnly: boolean
  /** No `/` left in the pattern: it is matched against the last path segment alone. */
  basenameOnly: boolean
  /** `null` for a rule git reads but that can match nothing (`a\`, `a[b`, `[[:nope:]]`). */
  regex: RegExp | null
}

/** A rule as it appears in the file, for the caller to vet before anything is compiled. */
export interface RuleLine {
  /** 0-based line number. */
  index: number
  /** The rule's bytes, one character per byte, as it will be compiled. */
  bytes: string
}

const UTF8_BOM = "\xef\xbb\xbf"

/**
 * The lines git reads as rules (`add_patterns_from_buffer`, `trim_trailing_spaces`): a leading
 * byte-order mark is skipped, a line that is empty or starts with `#` is not a rule, one CR
 * before the newline is dropped, and then trailing spaces unless the last is escaped. Tabs stay.
 * A line that is only spaces is still a rule: an empty one, which matches nothing.
 */
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
      // An escape protects the byte after it, a space included; a backslash ending the line
      // leaves it as it is.
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

/**
 * `parse_path_pattern`, then the glob. A leading `!` negates; a trailing `/` restricts the rule
 * to directories and is dropped; a pattern with no other `/` is matched against the basename,
 * anything else against the path relative to the file, with a leading `/` dropped.
 *
 * `match_pathname` compares the pattern's literal head — everything before the first `*`, `?`,
 * `[` or `\` — as a plain string and hands only the rest to the glob. That is not just speed:
 * the glob reads a `**` as "any directories" only at the start of what it was handed or after a
 * `/`, so `a**\/b` matches `a/x/b` in git because the `**` lands at the start once `a` is gone.
 * The same `**` in a basename rule, which gets no such split, is one `*`.
 */
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

/** `simple_length`: how much of the pattern comes before its first special byte. */
function literalHeadLength(pattern: string): number {
  const found = pattern.search(/[*?[\\]/)
  return found < 0 ? pattern.length : found
}

/**
 * `wildmatch` with `WM_PATHNAME`, as a regex body, or `null` where git aborts the match and
 * the rule matches nothing: a pattern ending in a lone `\`, an unterminated bracket, an unknown
 * POSIX class.
 */
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
          // `**/`: no directories, or any number of them.
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

/**
 * One bracket expression, from the `[` at `start`; `end` is just past its `]`.
 *
 * The member loop runs before it checks for the closing `]`, so a `]` right after `[` or `[!` is
 * a member. `!` and `^` both negate. `x-y` adds `x` itself and, when `x <= y`, the range — a
 * reversed range is `x` alone — and after a range or a class a `-` is literal again. A `[:` that
 * the next `]` does not close with `:]` is a literal `[`. No member ever matches `/`.
 */
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

/**
 * Git's own `sane_ctype` classes, measured byte by byte: ASCII only whatever the locale, and
 * `space` without the vertical tab and form feed a C library would add.
 */
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
