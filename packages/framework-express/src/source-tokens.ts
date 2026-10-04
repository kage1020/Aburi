/**
 * One token of JavaScript or TypeScript source, as `tokenize` reads it.
 *
 * - `word`: an identifier, keyword or number.
 * - `string`: a quoted string, or a template literal with no substitution, which is everything
 *   a module specifier can be written as. `text` is what lies between the quotes, escapes
 *   unread.
 * - `other`: one punctuation character (`++` and `--` are one token), a regular-expression
 *   literal, an unterminated string, or a backtick that opens, continues or closes a template
 *   literal with substitutions.
 */
export interface SourceToken {
  kind: "word" | "string" | "other"
  text: string
}

/**
 * The tokens of `content`, with comments skipped and every string, template and
 * regular-expression literal read whole, so that nothing written inside one reads as code.
 * Good enough to find an import or a `require` call; not a parser.
 *
 * A `/` that is not a comment is a regular-expression literal where an expression can start
 * and a division after a value, which is decided by the token before it: after a name, a
 * number, a literal, `)` or `]` it divides; after an operator, `(`, `,`, `{`, a block's `}`,
 * a keyword such as `return` or `typeof`, or the `)` of an `if (…)`, `for (…)` or
 * `while (…)` head it starts a literal. `++` and `--` keep the reading they found, and so
 * does TypeScript's non-null `!`. A literal cannot span lines, so a `/` that finds no closing
 * `/` on its line is read as a division and costs nothing. Where the rule guesses, it guesses
 * for the common case: any `}` is taken to close a block, so a division straight after an
 * object literal (`x = {} / 2`) is read as a literal, and so is one after `yield` or `await`
 * used as a plain name. A literal read in error runs to the next `/` on its line at most.
 *
 * A template literal's `${…}` is read as code, braces counted, so a string, comment or
 * nested template inside it is stepped over and the `}` that closes it resumes the template.
 *
 * What it cannot read is JSX text, because telling `<p>Don't</p>` apart from code takes a
 * parser. A quote in JSX text opens a string to the end of its line, a backtick a template to
 * the next backtick in the file, `//` a comment to the end of the line, and `/*` a block
 * comment to wherever one next closes. Both directions follow. What the span covers is lost,
 * so a `require` written inside it is missed: `<p>Don't</p>; const e = require("express")`
 * reads as no `require`. And a comment whose opener the span swallows is read as code, so a
 * `require` commented out on the lines after `<p>Don't</p> /* old:` is found.
 */
export function tokenize(content: string): SourceToken[] {
  const tokens: SourceToken[] = []
  // Open `(`, `{` and `${`, innermost last, for what a `)` or `}` closes.
  const frames: Frame[] = []
  // Whether a `/` here begins a regular-expression literal rather than divides.
  let regexAllowed = true
  let i = 0

  // `start` is just past a template's opening backtick (`head`) or past the `}` that closed
  // one of its substitutions. Returns where code resumes.
  const readTemplate = (start: number, head: boolean): number => {
    let j = start
    while (j < content.length) {
      const char = content[j]
      if (char === "\\") {
        j += 2
        continue
      }
      if (char === "`") {
        tokens.push(
          head ? { kind: "string", text: content.slice(start, j) } : { kind: "other", text: "`" },
        )
        regexAllowed = false
        return j + 1
      }
      if (char === "$" && content[j + 1] === "{") {
        tokens.push({ kind: "other", text: "`" })
        frames.push("interpolation")
        regexAllowed = true
        return j + 2
      }
      j += 1
    }
    tokens.push({ kind: "other", text: "`" })
    return content.length
  }

  while (i < content.length) {
    const char = content[i] as string
    const next = content[i + 1]

    if (isSpace(char)) {
      i += 1
      continue
    }

    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", i)
      i = end === -1 ? content.length : end
      continue
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2)
      i = end === -1 ? content.length : end + 2
      continue
    }
    if (char === "/" && regexAllowed) {
      const end = regexEnd(content, i)
      if (end !== -1) {
        tokens.push({ kind: "other", text: content.slice(i, end) })
        regexAllowed = false
        i = end
        continue
      }
    }

    if (char === '"' || char === "'") {
      let end = i + 1
      let closed = false
      while (end < content.length) {
        const inner = content[end]
        if (inner === "\\") {
          end += 2
          continue
        }
        if (inner === char) {
          closed = true
          break
        }
        // A quote string cannot run past the end of its line.
        if (inner === "\n") break
        end += 1
      }
      tokens.push(
        closed
          ? { kind: "string", text: content.slice(i + 1, end) }
          : { kind: "other", text: char },
      )
      regexAllowed = false
      i = closed ? end + 1 : end
      continue
    }

    if (char === "`") {
      i = readTemplate(i + 1, true)
      continue
    }

    if (isWordChar(char)) {
      let end = i + 1
      while (end < content.length && isWordChar(content[end] as string)) end += 1
      const text = content.slice(i, end)
      // After `.` a keyword is a property name (`res.delete / 2`), which is a value.
      const property = isOther(tokens.at(-1), ".")
      tokens.push({ kind: "word", text })
      regexAllowed = !property && REGEX_AFTER_KEYWORDS.has(text)
      i = end
      continue
    }

    if ((char === "+" || char === "-") && next === char) {
      // Postfix after a value and prefix before one, so the reading it found still holds.
      tokens.push({ kind: "other", text: char + char })
      i += 2
      continue
    }

    if (char === "(") {
      frames.push(isControlKeyword(tokens) ? "control-paren" : "paren")
      regexAllowed = true
    } else if (char === ")") {
      const top = frames.at(-1)
      if (top === "paren" || top === "control-paren") frames.pop()
      // `if (ok) /re/` starts a statement; `f(x) / 2` divides.
      regexAllowed = top === "control-paren"
    } else if (char === "{") {
      frames.push("brace")
      regexAllowed = true
    } else if (char === "}") {
      // Close the innermost brace or substitution, dropping any `(` left open inside it.
      let top = frames.pop()
      while (top === "paren" || top === "control-paren") top = frames.pop()
      if (top === "interpolation") {
        i = readTemplate(i + 1, false)
        continue
      }
      regexAllowed = true
    } else if (char === "]") {
      regexAllowed = false
    } else if (char === "!" && next !== "=" && !regexAllowed) {
      // TypeScript's non-null assertion: `value!` is still a value.
    } else {
      regexAllowed = true
    }
    tokens.push({ kind: "other", text: char })
    i += 1
  }

  return tokens
}

type Frame = "paren" | "control-paren" | "brace" | "interpolation"

/** Keywords after which an expression, and so a regular-expression literal, can start. */
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
])

/** Statement heads whose `(…)` is followed by a statement rather than a value. */
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(["for", "if", "while", "with"])

/** Whether the `(` about to be pushed follows `if`, `for`, `while` or `with` as a keyword. */
function isControlKeyword(tokens: readonly SourceToken[]): boolean {
  const before = tokens.at(-1)
  return (
    before?.kind === "word" && CONTROL_KEYWORDS.has(before.text) && !isOther(tokens.at(-2), ".")
  )
}

/**
 * The index just past the regular-expression literal whose opening `/` is at `start`, flags
 * included, or `-1` when its line ends first. A `/` inside a character class does not close
 * it, and a backslash escapes the character after it.
 */
function regexEnd(content: string, start: number): number {
  let inClass = false
  let i = start + 1
  while (i < content.length) {
    const char = content[i]
    if (char === "\n") return -1
    if (char === "\\") {
      if (content[i + 1] === "\n") return -1
      i += 2
      continue
    }
    if (char === "[") inClass = true
    else if (char === "]") inClass = false
    else if (char === "/" && !inClass) {
      i += 1
      while (i < content.length && isWordChar(content[i] as string)) i += 1
      return i
    }
    i += 1
  }
  return -1
}

export function isOther(token: SourceToken | undefined, text: string): boolean {
  return token?.kind === "other" && token.text === text
}

const WHITESPACE = /\s/

function isSpace(char: string): boolean {
  const code = char.charCodeAt(0)
  return code <= 32 || (code >= 128 && WHITESPACE.test(char))
}

/** ASCII letters, digits, `_`, `$`, `#` (a private name) and any non-space character past ASCII. */
function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" ||
    char === "$" ||
    char === "#" ||
    (code >= 128 && !WHITESPACE.test(char))
  )
}
