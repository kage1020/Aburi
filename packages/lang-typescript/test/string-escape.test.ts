import { describe, expect, it } from "vitest"
import {
  decodeEscapeSequence,
  decodeStringLiteral,
  decodeStringLiteralOrRaw,
} from "../src/string-escape"
import { BACKSLASH, parseSource, requireTree } from "./fixtures/ctx"

/** The string node an import of `written` parses its specifier into. */
async function specifierNode(written: string) {
  const source = `import x from ${written}`
  const [node] = requireTree((await parseSource(source)).tree).rootNode.descendantsOfType("string")
  if (node === undefined || node === null) throw new Error(`no string node in ${source}`)
  return node
}

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

    expect(decoded).toBe("\u{1F600}")
    expect(decoded.length).toBe(2)
    expect([...decoded]).toHaveLength(1)
  })

  it("decodes the largest code point ECMAScript defines", () => {
    expect(decodeEscapeSequence(`${BACKSLASH}u{10FFFF}`)).toBe("\u{10ffff}")
  })

  it("keeps a braced escape above it, which the grammar still admits", () => {
    expect(decodeEscapeSequence(`${BACKSLASH}u{110000}`)).toBe("u{110000}")
    expect(decodeEscapeSequence(`${BACKSLASH}u{FFFFFFFFFF}`)).toBe("u{FFFFFFFFFF}")
  })

  it.each([
    [`${BACKSLASH}u{}`, "u{}"],
    [`${BACKSLASH}uZZZZ`, "uZZZZ"],
  ])("keeps %s, which the grammar refuses before it reaches here", (raw, expected) => {
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
    expect(decodeEscapeSequence(raw)).toBe(expected)
  })

  it("returns a string carrying no escape unchanged", () => {
    expect(decodeEscapeSequence("ab")).toBe("ab")
  })

  it.each([
    ["nothing", ""],
    ["a lone backslash", BACKSLASH],
  ])("returns %s unchanged, which is too short to carry an escape", (_label, raw) => {
    expect(decodeEscapeSequence(raw)).toBe(raw)
  })
})

describe("what a literal decodes to, and whether that is all of it", () => {
  const literalOf = async (written: string) => decodeStringLiteral(await specifierNode(written))

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
    const continuation = await literalOf(`"${BACKSLASH}\n"`)
    const unparsed = await literalOf(`"${BACKSLASH}uZZZZ"`)

    expect([continuation.value, unparsed.value]).toEqual(["", ""])
    expect([continuation.whole, unparsed.whole]).toEqual([true, false])
  })
})

describe("what a literal reads as when the fallback is allowed to stand in", () => {
  const readOf = async (written: string) => decodeStringLiteralOrRaw(await specifierNode(written))

  it.each([
    ["a plain literal as itself", '"./m"', "./m"],
    ["an escape as the character it names", `"./a${BACKSLASH}tb"`, "./a\tb"],
    ["an empty literal as empty, because it was read", '""', ""],
    ["a lone line continuation as empty, for the same reason", `"${BACKSLASH}\n"`, ""],
    ["a partial read as the part that parsed", `"a${BACKSLASH}uZZZZb"`, "a"],
    [
      "an unread literal as its source text, quotes off",
      `"${BACKSLASH}uZZZZ"`,
      `${BACKSLASH}uZZZZ`,
    ],
    ["a single-quoted unread literal the same way", `'${BACKSLASH}uZZZZ'`, `${BACKSLASH}uZZZZ`],
  ])("reads %s", async (_label, written, expected) => {
    expect(await readOf(written)).toBe(expected)
  })

  it("keeps two unread literals apart, which their decoded values cannot", async () => {
    const first = await readOf(`"${BACKSLASH}uZZZZ/a"`)
    const second = await readOf(`"${BACKSLASH}uZZZZ/b"`)

    expect(first).not.toBe(second)
  })
})
