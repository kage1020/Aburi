import { describe, expect, it } from "vitest"
import { decodeEscapeSequence, decodeStringLiteral } from "../src/string-escape"
import { BACKSLASH, parseSource, requireTree } from "./fixtures/ctx"

/**
 * The decoder is its own unit because the table is the interesting part: one row per class of
 * escape, read against what tree-sitter actually hands over — the escape's source text with
 * the backslash still on it.
 *
 * What the grammar admits is what this has to cover, and it admits more than ECMAScript.
 * `"\uZZZZ"`, `"\u12b"`, `"\u{}"` and `"\xZZ"` parse as ERROR nodes rather than
 * `escape_sequence`, so an ill-formed hex or unicode escape never reaches here. A braced
 * escape is checked for shape and not for range, so `\u{110000}` does — and joins `\1` and
 * `\8` in the set of escapes with no legal value, which come back as their own text.
 */

describe("the escapes that name a control character", () => {
  it.each([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ["0", "\0"],
  ])("decodes %s", (body, expected) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${body}`)).toBe(expected)
  })
})

describe("the escapes that quote a character", () => {
  it.each(['"', "'", BACKSLASH, "`", "$"])("decodes %s to itself, once", (char) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${char}`)).toBe(char)
  })
})

describe("the numeric escapes", () => {
  it.each([
    [`${BACKSLASH}x62`, "b"],
    [`${BACKSLASH}x00`, "\0"],
    [`${BACKSLASH}xFF`, "ÿ"],
    [`${BACKSLASH}xff`, "ÿ"],
    [`${BACKSLASH}u0062`, "b"],
    [`${BACKSLASH}u00E9`, "é"],
    [`${BACKSLASH}u{62}`, "b"],
    [`${BACKSLASH}u{0}`, "\0"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("decodes a braced escape above the BMP as the code point, not the low half of it", () => {
    const decoded = decodeEscapeSequence(`${BACKSLASH}u{1F600}`)

    // `fromCharCode` would truncate to U+F600 and answer a single unit from the private use
    // area. The astral character is two UTF-16 units and one code point.
    expect(decoded).toBe("\u{1F600}")
    expect(decoded.length).toBe(2)
    expect([...decoded]).toHaveLength(1)
  })

  it("decodes the largest code point ECMAScript defines", () => {
    expect(decodeEscapeSequence(`${BACKSLASH}u{10FFFF}`)).toBe("\u{10ffff}")
  })

  it("keeps a braced escape above it, which the grammar still admits", () => {
    // `String.fromCodePoint` throws a `RangeError` on these, and the grammar hands them over
    // as ordinary `escape_sequence` nodes — so without the range check the throw leaves
    // `parseFile`, lands on the per-file boundary, and costs the whole file over one
    // character in one specifier.
    expect(decodeEscapeSequence(`${BACKSLASH}u{110000}`)).toBe("u{110000}")
    expect(decodeEscapeSequence(`${BACKSLASH}u{FFFFFFFFFF}`)).toBe("u{FFFFFFFFFF}")
  })

  it.each([
    [`${BACKSLASH}u{}`, "u{}"],
    [`${BACKSLASH}uZZZZ`, "uZZZZ"],
  ])("keeps %s, which the grammar refuses before it reaches here", (raw, expected) => {
    // One row per `Number.isNaN` guard — braced and unbraced. Each parses as an ERROR node, so
    // nothing hands the decoder a hex body that is not a number; the rows are what make the
    // guards observable at all.
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })
})

describe("a line continuation contributes nothing", () => {
  it.each([
    ["LF", `${BACKSLASH}\n`],
    ["CRLF", `${BACKSLASH}\r\n`],
    ["CR", `${BACKSLASH}\r`],
    ["line separator", `${BACKSLASH}\u2028`],
    ["paragraph separator", `${BACKSLASH}\u2029`],
  ])("decodes a %s continuation to the empty string", (_label, raw) => {
    // The escape joins two source lines; it is not a character in the value. A specifier made
    // only of one is therefore empty, which is what sends it to the empty-specifier gate.
    expect(decodeEscapeSequence(raw)).toBe("")
  })
})

describe("anything else keeps what the author typed", () => {
  it.each(["a", "z", "A", "/", ".", "-", "é"])("decodes an identity escape of %s", (char) => {
    expect(decodeEscapeSequence(`${BACKSLASH}${char}`)).toBe(char)
  })

  it.each([
    [`${BACKSLASH}1`, "1"],
    [`${BACKSLASH}01`, "01"],
    [`${BACKSLASH}7`, "7"],
    [`${BACKSLASH}8`, "8"],
    [`${BACKSLASH}9`, "9"],
  ])("keeps the digits of a digit escape (%s)", (raw, expected) => {
    // `\1` is legacy octal and `\8` is a non-octal decimal escape. Both are a SyntaxError
    // inside a module, so neither has a correct value to produce: `1` is not what `\1` means
    // anywhere, but it is what the author typed, and it beats inventing a control character
    // that would then travel through the IR as part of a module name.
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("returns a string carrying no escape unchanged", () => {
    // Defensive: the caller only ever hands over an `escape_sequence`, so this arm answers a
    // question nobody asks — but returning the input is the only answer that cannot corrupt a
    // specifier if that ever stops being true.
    expect(decodeEscapeSequence("ab")).toBe("ab")
  })
})

/**
 * `whole` is the half the decoder answers that its value cannot: an escape may decode to
 * nothing, so an empty read and an unread literal look identical from the value alone. One
 * caller acts on the difference — a class member's name refuses a partial read — and one turns
 * it into which diagnostic a module specifier gets, so the bit is pinned here rather than only
 * through whichever of them happens to exercise it.
 */
describe("what a literal decodes to, and whether that is all of it", () => {
  async function literalOf(written: string) {
    // An import, because that is where a literal survives recovery: a declaration whose
    // whole literal failed to parse leaves no `string` node at all, and a specifier
    // position keeps one. It is also the reader this bit exists for.
    const source = `import x from ${written}`
    const result = await parseSource(source)
    const value = requireTree(result.tree).rootNode.descendantsOfType("string")[0]
    if (value === undefined || value === null) throw new Error(`no string node in ${source}`)
    return decodeStringLiteral(value)
  }

  it.each([
    ["a plain literal", '"./m"', "./m", true],
    ["an escape", `"./a${BACKSLASH}tb"`, "./a\tb", true],
    ["an empty literal", '""', "", true],
    ["a literal that is only a line continuation", `"${BACKSLASH}\n"`, "", true],
    ["a literal that is entirely an ERROR", `"${BACKSLASH}uZZZZ"`, "", false],
    ["a literal with an ERROR after a fragment", `"a${BACKSLASH}uZZZZb"`, "a", false],
  ])("reads %s", async (_label, written, value, whole) => {
    expect(await literalOf(written)).toEqual({ value, whole })
  })

  it("tells an empty read from an unread literal, which the value alone cannot", async () => {
    // Both answer `value: ""`. Only `whole` says which one the author wrote, and the
    // specifier reader turns exactly that into "this import names no module" versus "the
    // parser has already said why the name is missing".
    const continuation = await literalOf(`"${BACKSLASH}\n"`)
    const unparsed = await literalOf(`"${BACKSLASH}uZZZZ"`)

    expect([continuation.value, unparsed.value]).toEqual(["", ""])
    expect([continuation.whole, unparsed.whole]).toEqual([true, false])
  })
})
