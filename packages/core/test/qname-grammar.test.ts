import { describe, expect, it } from "vitest"
import {
  CoreError,
  DEFAULT_EXPORT_QNAME,
  isQnameSegment,
  isQualifiedName,
  makeSymbolId,
} from "../src"

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
    expect(build(qname)).toBe(`ts:src/a.ts#${qname}`)
  })

  it("accepts a qualified name whose segments are each non-ASCII", () => {
    expect(build("クラス.メソッド")).toBe("ts:src/a.ts#クラス.メソッド")
    expect(build("クラス::静的")).toBe("ts:src/a.ts#クラス::静的")
  })

  it("accepts a combining mark after the first character, and stores it composed", () => {
    expect(build(`a${COMBINING_ACUTE}b`)).toBe("ts:src/a.ts#áb")
  })

  it("normalizes a decomposed spelling before it validates one", () => {
    const decomposed = build(`cafe${COMBINING_ACUTE}`)

    expect(decomposed).toBe("ts:src/a.ts#café")
    expect(decomposed).toBe(decomposed.normalize("NFC"))
  })
})

describe("a private member keeps its `#`, after a separator only", () => {
  it.each([
    ["an instance member", "C.#v"],
    ["a static member", "Q::#v"],
    ["a nested owner", "A.B.#v"],
  ])("accepts %s", (_label, qname) => {
    expect(build(qname)).toBe(`ts:src/a.ts#${qname}`)
    expect(isQualifiedName(qname)).toBe(true)
  })

  it.each([
    ["a leading `#`, which would sit beside the id's own", "#v"],
    ["a `#` inside a segment", "Q#v"],
    ["a bare `#` member", "Q.#"],
    ["a bare `#` owner", "#.v"],
    ["two `#`", "Q.##v"],
  ])("refuses %s", (_label, qname) => {
    expect(refusalFor(qname).code).toBe("anonymous-symbol-id-attempted")
    expect(isQualifiedName(qname)).toBe(false)
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
    expect(refusalFor("＿x").code).toBe("anonymous-symbol-id-attempted")
  })

  it("still refuses an empty segment, which the separator rule reports first", () => {
    expect(refusalFor("A.").code).toBe("anonymous-symbol-id-attempted")
    expect(refusalFor(".A").code).toBe("anonymous-symbol-id-attempted")
  })

  it("keeps the default sentinel, which is exempted before the segment check", () => {
    expect(build(DEFAULT_EXPORT_QNAME)).toBe(`ts:src/a.ts#${DEFAULT_EXPORT_QNAME}`)
    expect(refusalFor("<other>").code).toBe("anonymous-symbol-id-attempted")
  })
})

describe("a producer can ask whether a name is a segment before it builds one", () => {
  it.each([
    ["a plain identifier", "ok"],
    ["a dollar first", "$x"],
    ["an underscore first", "_x"],
    ["a digit after the first character", "ok1"],
    ["a non-ASCII identifier", "ユーザー取得"],
    ["an accented identifier", "café"],
  ])("accepts %s", (_label, segment) => {
    expect(isQnameSegment(segment)).toBe(true)
  })

  it.each([
    ["a hyphen", "a-b"],
    ["the instance separator", "a.b"],
    ["the static separator", "a::b"],
    ["a number", "1"],
    ["a decimal", "1.5"],
    ["nothing", ""],
    ["a private name, unless asked for", "#v"],
    ["a space", "a b"],
    ["the default sentinel", DEFAULT_EXPORT_QNAME],
  ])("refuses %s", (_label, segment) => {
    expect(isQnameSegment(segment)).toBe(false)
  })

  it("accepts a private name only when asked for one", () => {
    expect(isQnameSegment("#v")).toBe(false)
    expect(isQnameSegment("#v", { privateName: true })).toBe(true)
    expect(isQnameSegment("#ユーザー", { privateName: true })).toBe(true)
  })

  it.each([
    ["a bare `#`", "#"],
    ["a `#` after the first character", "a#b"],
    ["two `#`", "##v"],
    ["a `#` before a digit", "#1"],
  ])("refuses %s even when a private name is asked for", (_label, segment) => {
    expect(isQnameSegment(segment, { privateName: true })).toBe(false)
  })

  it("is stricter than the whole-qname predicate, which is the reason it exists", () => {
    expect(isQualifiedName("a.b")).toBe(true)
    expect(isQnameSegment("a.b")).toBe(false)
  })
})
