/**
 * Decode one `escape_sequence` node's source text into the characters it names.
 *
 * The input is what tree-sitter hands over — the escape with its backslash still on it, from
 * `\n` through `\u{1F600}` to a line continuation. The output is the value, so a caller
 * joining fragments and escapes in source order reconstructs the string the author wrote.
 *
 * **What the grammar admits is what this covers, and it admits more than ECMAScript.**
 * `"\uZZZZ"`, `"\u12b"`, `"\u{}"` and `"\xZZ"` parse as ERROR nodes rather than
 * `escape_sequence` and are already reported as recoverable syntax errors, so an ill-formed
 * hex or unicode escape never arrives here. A braced escape is different: the grammar checks
 * its *shape* and not its *range*, so `\u{110000}` does arrive, and has no value ECMAScript
 * will give it.
 *
 * Every escape with no legal value is handled the same way — `\u{110000}`, `\1`, `\8` — and
 * it is the way the identity arm already worked: the text the author wrote comes back, minus
 * the backslash. Inventing a value would put a module name in the IR that the source does not
 * contain, and throwing would cost the file. Nothing downstream learns the specifier was
 * illegal, which is a gap worth its own change rather than a silent one worth pretending away.
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
    // The range check is the load-bearing half. The grammar accepts `\u{110000}` as an
    // `escape_sequence`, and `String.fromCodePoint` throws a `RangeError` on it — which would
    // leave `parseFile`, land on the per-file boundary, and cost the whole file over one
    // character in one specifier.
    if (Number.isNaN(codePoint) || codePoint > MAX_CODE_POINT) return body
    // `fromCodePoint`, not `fromCharCode`: the braced form is the only one that can name a
    // code point above the BMP, and truncating `\u{1F600}` to its low 16 bits would answer a
    // private-use character instead.
    return String.fromCodePoint(codePoint)
  }
  if (body.startsWith("u") || body.startsWith("x")) {
    const codeUnit = Number.parseInt(body.slice(1), 16)
    return Number.isNaN(codeUnit) ? body : String.fromCharCode(codeUnit)
  }

  // Everything else is the character itself: `\"`, `\\`, a backtick, a `$`, an identity escape
  // like `\a`, and the digit escapes the grammar still accepts — `\1` (legacy octal) and `\8`
  // (a non-octal decimal escape). Both are a SyntaxError inside a module, so there is no
  // correct value to produce; `1` is not what `\1` means anywhere, but it is what the author
  // typed, and it beats inventing a control character that would then travel through the IR as
  // part of a module name.
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
