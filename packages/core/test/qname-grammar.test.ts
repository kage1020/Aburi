import { describe, expect, it } from "vitest"
import { CoreError, DEFAULT_EXPORT_QNAME, makeSymbolId } from "../src"

/**
 * The qualified-name segment grammar used to be `[A-Za-z_$][A-Za-z0-9_$]*`, which refuses
 * identifiers ECMAScript defines and `schema/aburi.ir.v1.json#/$defs/SymbolId` already
 * accepts — its pattern is `^[a-z][a-z0-9]*:[^#\\]+#[^\\]+$`. A Japanese or accented
 * declaration therefore cost its whole file: `makeSymbolId` throws, the throw reaches the
 * per-file boundary, and every Symbol in the file goes with it.
 *
 * The grammar is `[$_\p{ID_Start}][$\p{ID_Continue}]*` now, which is ECMAScript's
 * IdentifierName less the escape forms. Only `$` and `_` are named — `$` is in neither
 * property, `_` is in `ID_Continue` and not in `ID_Start` — and ZWNJ and ZWJ, which
 * ECMAScript names separately, are already inside `ID_Continue` here.
 *
 * What it still refuses is what is not a name at all — a destructuring pattern's text, a
 * computed member's brackets — which the extraction side no longer sends here.
 */

const ZWNJ = "\u200C"
const ZWJ = "\u200D"
const COMBINING_ACUTE = "\u0301"

function build(qualifiedName: string) {
  return makeSymbolId({ language: "ts", file: "src/a.ts", qualifiedName })
}

function refusalFor(qualifiedName: string): CoreError {
  try {
    build(qualifiedName)
  } catch (error) {
    if (error instanceof CoreError) return error
    throw error
  }
  throw new Error(`expected makeSymbolId to refuse "${qualifiedName}"`)
}

describe("an identifier ECMAScript defines is a qualified name", () => {
  it.each([
    ["Japanese", "ユーザー取得"],
    ["an accented Latin letter", "café"],
    ["Greek", "Ωmega"],
    ["Cyrillic", "функция"],
    ["Han", "取得"],
    ["a fullwidth letter", "Ｘy"],
    ["a digit after the first character", "a1"],
    ["an underscore first", "_x"],
    ["a dollar first", "$x"],
    ["a dollar last", "x$"],
    ["an underscore alone", "_"],
    ["a dollar alone", "$"],
  ])("accepts %s", (_label, qname) => {
    expect(build(qname)).toBe(`ts:src/a.ts#${qname}`)
  })

  it.each([
    ["a zero-width non-joiner", `a${ZWNJ}b`],
    ["a zero-width joiner", `a${ZWJ}b`],
  ])("accepts %s, which is an identifier part and not a letter", (_label, qname) => {
    // ECMAScript names both in IdentifierPartChar, and a Persian or Arabic-script identifier
    // uses them to control ligature shaping. `\p{ID_Continue}` already covers them here —
    // measured — so this pins the behaviour rather than a second spelling of it, and the
    // tree-sitter grammar parses `a<ZWNJ>b` as one `identifier` either way.
    expect(build(qname)).toBe(`ts:src/a.ts#${qname}`)
  })

  it("accepts a qualified name whose segments are each non-ASCII", () => {
    expect(build("クラス.メソッド")).toBe("ts:src/a.ts#クラス.メソッド")
    expect(build("クラス::静的")).toBe("ts:src/a.ts#クラス::静的")
  })

  it("accepts a combining mark after the first character, and stores it composed", () => {
    // `normalizeParts` runs before the check, so the segment validated and the segment stored
    // are the composed one — the id never carries the spelling that was handed in.
    expect(build(`a${COMBINING_ACUTE}b`)).toBe("ts:src/a.ts#áb")
  })

  it("normalizes a decomposed spelling before it validates one", () => {
    // `normalizeParts` runs first, so an NFD `café` is checked and stored as its NFC form —
    // and the widened grammar accepts both spellings anyway, since a combining mark is
    // `ID_Continue`.
    const decomposed = build(`cafe${COMBINING_ACUTE}`)

    expect(decomposed).toBe("ts:src/a.ts#café")
    expect(decomposed).toBe(decomposed.normalize("NFC"))
  })
})

describe("what is not a name is still refused, and named", () => {
  it.each([
    ["an object pattern", "{ GET, POST }"],
    ["an array pattern", "[a, b]"],
    ["a computed member name", "[Symbol.iterator]"],
    ["a space", "a b"],
    ["a hyphen", "a-b"],
    ["a leading digit", "1a"],
    ["a leading combining mark", `${COMBINING_ACUTE}a`],
    ["a quote", `"a"`],
    ["an emoji", "🙂"],
    ["a fullwidth underscore", "＿x"],
  ])("refuses %s", (_label, qname) => {
    const error = refusalFor(qname)

    expect(error.code).toBe("anonymous-symbol-id-attempted")
    expect(error.message).toContain("non-identifier segment")
  })

  it("refuses a connector punctuation mark that is not the underscore itself", () => {
    // U+FF3F FULLWIDTH LOW LINE is `Pc`, so it is `ID_Continue` but not `ID_Start`, and
    // ECMAScript adds only U+005F by name. `tsc` agrees: `function ＿x() {}` is TS1127,
    // "Invalid character". The tree-sitter grammar is more permissive and parses it as an
    // `identifier`, so a file containing one still loses its Symbols — but the source does
    // not compile, and admitting the character would put a name in the IR that no TypeScript
    // program can declare.
    expect(refusalFor("＿x").code).toBe("anonymous-symbol-id-attempted")
  })

  it("still refuses an empty segment, which the separator rule reports first", () => {
    expect(refusalFor("A.").code).toBe("anonymous-symbol-id-attempted")
    expect(refusalFor(".A").code).toBe("anonymous-symbol-id-attempted")
  })

  it("keeps the default sentinel, which is exempted before the segment check", () => {
    // `<` and `>` are in neither character class, so the sentinel would fail the grammar if
    // it ever reached it. It does not, and this is what says so.
    expect(build(DEFAULT_EXPORT_QNAME)).toBe(`ts:src/a.ts#${DEFAULT_EXPORT_QNAME}`)
    expect(refusalFor("<other>").code).toBe("anonymous-symbol-id-attempted")
  })
})
