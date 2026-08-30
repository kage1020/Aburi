import { describe, expect, it } from "vitest"
import { decodeEscapeSequence } from "../src/string-escape"

/**
 * The decoder is its own unit because the table is the interesting part: one row per class of
 * escape, read against what tree-sitter actually hands over — the escape's source text with
 * the backslash still on it.
 *
 * What the grammar admits is what this has to cover, and no more. `"\uZZZZ"` and `"\xZZ"`
 * parse as ERROR nodes rather than `escape_sequence`, so an invalid hex or unicode escape
 * never reaches here; the identity arm is for shapes the grammar accepts, not a repair for
 * ones it rejects.
 */

const BS = String.fromCharCode(92)

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
    expect(decodeEscapeSequence(`${BS}${body}`)).toBe(expected)
  })
})

describe("the escapes that quote a character", () => {
  it.each(['"', "'", BS, "`", "$"])("decodes %s to itself, once", (char) => {
    expect(decodeEscapeSequence(`${BS}${char}`)).toBe(char)
  })
})

describe("the numeric escapes", () => {
  it.each([
    [`${BS}x62`, "b"],
    [`${BS}x00`, "\0"],
    [`${BS}xFF`, "ÿ"],
    [`${BS}xff`, "ÿ"],
    [`${BS}u0062`, "b"],
    [`${BS}u00E9`, "é"],
    [`${BS}u{62}`, "b"],
    [`${BS}u{0}`, "\0"],
  ])("decodes %s", (raw, expected) => {
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("decodes a braced escape above the BMP as the code point, not the low half of it", () => {
    const decoded = decodeEscapeSequence(`${BS}u{1F600}`)

    // `fromCharCode` would truncate to U+F600 and answer a single unit from the private use
    // area. The astral character is two UTF-16 units and one code point.
    expect(decoded).toBe("\u{1F600}")
    expect(decoded.length).toBe(2)
    expect([...decoded]).toHaveLength(1)
  })

  it("decodes the largest code point the syntax allows", () => {
    expect(decodeEscapeSequence(`${BS}u{10FFFF}`)).toBe("\u{10ffff}")
  })
})

describe("a line continuation contributes nothing", () => {
  it.each([
    ["LF", `${BS}\n`],
    ["CRLF", `${BS}\r\n`],
    ["CR", `${BS}\r`],
    ["line separator", `${BS}\u2028`],
    ["paragraph separator", `${BS}\u2029`],
  ])("decodes a %s continuation to the empty string", (_label, raw) => {
    // The escape joins two source lines; it is not a character in the value. A specifier made
    // only of one is therefore empty, which is what sends it to the empty-specifier gate.
    expect(decodeEscapeSequence(raw)).toBe("")
  })
})

describe("anything else keeps what the author typed", () => {
  it.each(["a", "z", "A", "/", ".", "-", "é"])("decodes an identity escape of %s", (char) => {
    expect(decodeEscapeSequence(`${BS}${char}`)).toBe(char)
  })

  it.each([
    [`${BS}1`, "1"],
    [`${BS}01`, "01"],
    [`${BS}7`, "7"],
  ])("keeps the digits of a legacy octal escape (%s)", (raw, expected) => {
    // Legacy octal is a SyntaxError inside a module, so there is no correct value to produce.
    // Keeping the characters the author typed beats inventing a control character that would
    // then travel through the IR as a module name.
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("returns a string carrying no escape unchanged", () => {
    // Defensive: the caller only ever hands over an `escape_sequence`, so this arm answers a
    // question nobody asks — but returning the input is the only answer that cannot corrupt a
    // specifier if that ever stops being true.
    expect(decodeEscapeSequence("ab")).toBe("ab")
    expect(decodeEscapeSequence("")).toBe("")
    expect(decodeEscapeSequence(BS)).toBe(BS)
  })
})
