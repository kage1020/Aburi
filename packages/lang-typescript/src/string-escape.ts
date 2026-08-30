/**
 * Decode one `escape_sequence` node's source text into the characters it names.
 *
 * The input is what tree-sitter hands over — the escape with its backslash still on it, from
 * `\n` through `\u{1F600}` to a line continuation. The output is the value, so a caller
 * joining fragments and escapes in source order reconstructs the string the author wrote.
 *
 * **What the grammar admits is what this covers.** `"\uZZZZ"` and `"\xZZ"` parse as ERROR
 * nodes rather than `escape_sequence` and are already reported as recoverable syntax errors,
 * so an ill-formed hex or unicode escape never arrives here. The identity arm is for the
 * shapes the grammar accepts and ECMAScript reads as the character itself — `\a` is `a` — not
 * a repair for source the parser rejected.
 */
export function decodeEscapeSequence(raw: string): string {
  // Defensive rather than reachable: the only caller reads `escape_sequence` nodes, whose text
  // always starts with a backslash. Returning the input is the one answer that cannot corrupt
  // a module specifier if that ever stops being true.
  if (raw.length < 2 || raw[0] !== "\\") return raw
  const body = raw.slice(1)

  // A line continuation joins two source lines and contributes no character, which is why a
  // specifier written as nothing but one is empty and reaches the empty-specifier gate.
  if (LINE_TERMINATOR.test(body)) return ""

  const named = NAMED_ESCAPES.get(body)
  if (named !== undefined) return named

  if (body.startsWith("u{")) {
    const codePoint = Number.parseInt(body.slice(2, -1), 16)
    // `fromCodePoint`, not `fromCharCode`: the braced form is the only one that can name a
    // code point above the BMP, and truncating `\u{1F600}` to its low 16 bits would answer a
    // private-use character instead.
    return Number.isNaN(codePoint) ? body : String.fromCodePoint(codePoint)
  }
  if (body.startsWith("u") || body.startsWith("x")) {
    const codeUnit = Number.parseInt(body.slice(1), 16)
    return Number.isNaN(codeUnit) ? body : String.fromCharCode(codeUnit)
  }

  // Everything else is the character itself: `\"`, `\\`, a backtick, a `$`, an identity escape
  // like `\a`, and the legacy octal forms the grammar still accepts. Octal is a SyntaxError
  // inside a module, so there is no correct value to produce for `\1` — keeping what the
  // author typed beats inventing a control character that would then travel through the IR as
  // part of a module name.
  return body
}

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
