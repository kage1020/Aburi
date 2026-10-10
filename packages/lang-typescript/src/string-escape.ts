import type { Node } from "web-tree-sitter"

export interface DecodedLiteral {
  /** The characters the literal's `string_fragment`s and `escape_sequence`s name, in order. */
  value: string
  /** True when every named child read was a `string_fragment` or an `escape_sequence`. */
  whole: boolean
}

export function decodeStringLiteral(node: Node): DecodedLiteral {
  const parts: string[] = []
  let whole = true
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (child.type === "string_fragment") parts.push(child.text)
    else if (child.type === "escape_sequence") parts.push(decodeEscapeSequence(child.text))
    else whole = false
  }
  return { value: parts.join(""), whole }
}

export function decodeStringLiteralOrRaw(node: Node): string {
  const { value, whole } = decodeStringLiteral(node)
  if (whole || value !== "") return value
  const raw = node.text
  return raw.length >= 2 && QUOTE.test(raw) ? raw.slice(1, -1) : raw
}

/** The quotes a literal can open with — a template's is the backtick. */
const QUOTE = /^["'`]/

export function decodeEscapeSequence(raw: string): string {
  if (raw.length < 2 || raw[0] !== "\\") return raw
  const body = raw.slice(1)

  if (LINE_TERMINATOR.test(body)) return ""

  const named = NAMED_ESCAPES.get(body)
  if (named !== undefined) return named

  if (body.startsWith("u{")) {
    const codePoint = Number.parseInt(body.slice(2, -1), 16)
    if (Number.isNaN(codePoint) || codePoint > MAX_CODE_POINT) return body
    return String.fromCodePoint(codePoint)
  }
  if (body.startsWith("u") || body.startsWith("x")) {
    const codeUnit = Number.parseInt(body.slice(1), 16)
    return Number.isNaN(codeUnit) ? body : String.fromCharCode(codeUnit)
  }

  return body
}

/** The largest code point ECMAScript defines. The grammar admits braced escapes above it. */
const MAX_CODE_POINT = 0x10ffff

/** `\0` is NUL only on its own; `\01` is legacy octal and falls to the identity arm. */
const NAMED_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["0", "\0"],
])

/** CRLF is one continuation, not two, so the whole body is matched rather than the first char. */
const LINE_TERMINATOR = /^(\r\n|[\n\r\u2028\u2029])$/

export function readStaticString(node: Node): string | null {
  if (node.type === "template_string") {
    for (const child of node.namedChildren) {
      if (child?.type === "template_substitution") return null
    }
  } else if (node.type !== "string") {
    return null
  }
  return decodeStringLiteralOrRaw(node)
}
