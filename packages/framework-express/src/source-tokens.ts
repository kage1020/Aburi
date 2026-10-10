export interface SourceToken {
  kind: "word" | "string" | "other"
  text: string
}

export function tokenize(content: string): SourceToken[] {
  const tokens: SourceToken[] = []
  // Open `(`, `{` and `${`, innermost last, for what a `)` or `}` closes.
  const frames: Frame[] = []
  // Whether a `/` here begins a regular-expression literal rather than divides.
  let regexAllowed = true
  let i = 0

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

function isControlKeyword(tokens: readonly SourceToken[]): boolean {
  const before = tokens.at(-1)
  return (
    before?.kind === "word" && CONTROL_KEYWORDS.has(before.text) && !isOther(tokens.at(-2), ".")
  )
}

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
