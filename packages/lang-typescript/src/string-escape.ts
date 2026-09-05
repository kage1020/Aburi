import type { Node } from "web-tree-sitter"

/**
 * What a string literal's contents decode to, and whether that is all of them.
 *
 * The two callers want different things from the same read, so the read answers both rather
 * than picking one. A module specifier keeps whatever parsed — the parser's own syntax error
 * already accounts for the rest, and a second diagnostic would claim the author wrote no
 * module name. A name that is about to become part of a Symbol id refuses a partial read
 * instead, because what it would be believing is a name the source does not contain.
 *
 * *How much* a partial read drops is the grammar's business rather than this contract's — an
 * ERROR node's extent is whatever recovery gave it, and for the invalid escapes measured here
 * it runs to the end of the literal, so `"o\uZZZZk"` reads as `o` and not as `ok`.
 */
export interface DecodedLiteral {
  /** The characters the literal's `string_fragment`s and `escape_sequence`s name, in order. */
  value: string
  /** True when every named child read was a `string_fragment` or an `escape_sequence`. */
  whole: boolean
}

/**
 * Read a `string` or `template_string` node's contents into the characters they name.
 *
 * **An escape is decoded, not skipped.** `"./a\tb"` reads as `./a`, a tab, `b`; dropping the
 * escape answers `./ab`, a module that does not exist and is indistinguishable in the IR
 * from one that does.
 *
 * An empty `value` is not the same question as an empty literal, and `whole` is what separates
 * them: a literal whose only content is a line continuation was read, decodes to nothing, and
 * is whole; one whose content stands as an ERROR was not read and is not.
 */
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
