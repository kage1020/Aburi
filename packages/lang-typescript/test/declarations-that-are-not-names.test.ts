import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { idsOf, importsOf, symbolsOf } from "./fixtures/ctx"

describe("a destructuring declaration declares its bindings", () => {
  it.each([
    ["shorthand properties", "export const { GET, POST } = handlers", ["GET", "POST"]],
    ["a rename", "export const { a: b } = m", ["b"]],
    ["a shorthand default", "export const { a = 1 } = m", ["a"]],
    ["an array default", "export const [a = 1] = pair", ["a"]],
    ["a renamed default", "export const { a: b = 1 } = m", ["b"]],
    ["a default inside a nested array", "export const [[a = 1], b] = pair", ["a", "b"]],
    ["a nested pattern with a default", "export const { a: { b } = {} } = m", ["b"]],
    ["every default form at once", "export const { a = 1, b: c = 2, ...d } = m", ["a", "c", "d"]],
    ["a rest element", "export const { a, ...r } = m", ["a", "r"]],
    ["a nested pattern", "export const { a: { b } } = m", ["b"]],
    ["an array pattern", "export const [a, b] = pair", ["a", "b"]],
    ["a hole", "export const [, x] = pair", ["x"]],
    ["an array rest", "export const [a, ...r] = pair", ["a", "r"]],
    ["both kinds nested", "export const { a: [b, { c }] } = m", ["b", "c"]],
  ])("extracts one Symbol per binding — %s", async (_label, source, names) => {
    expect(await idsOf(source)).toEqual(names.map((n) => `ts:src/a.ts#${n}`))
  })

  it.each([
    ["a shorthand default", "export const { a = fallback } = m"],
    ["an array default", "export const [a = fallback] = pair"],
    ["a renamed default", "export const { z: a = fallback } = m"],
  ])("does not mistake %s's expression for a binding", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#a"])
  })

  it.each([
    ["a renamed member expression", "export const { a: obj.b } = m"],
    ["an array element", "export const [obj.a] = pair"],
    ["a rest element", "export const [...obj.a] = pair"],
  ])("refuses a pattern it cannot read, rather than binding nothing — %s", async (_l, source) => {
    await expect(idsOf(source)).rejects.toThrow(/Unmodelled node "member_expression"/)
  })

  it.each([
    ["an object pattern", "export const { a, /* c */ b } = m"],
    ["an array pattern", "export const [a, /* c */ b] = pair"],
  ])("reads past a comment written inside %s", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#a", "ts:src/a.ts#b"])
  })

  it("gives every binding the kind a plain const gets, and the whole declaration's range", async () => {
    const symbols = await symbolsOf("export const {\n  GET,\n  POST,\n} = handlers")

    expect(
      symbols.map((s) => [s.kind, s.visibility, s.derivedBy, s.source.startLine, s.source.endLine]),
    ).toEqual([
      ["const", "public", ["destructured-binding", "export-keyword"], 1, 4],
      ["const", "public", ["destructured-binding", "export-keyword"], 1, 4],
    ])
  })

  it("describes every binding of one declaration by the same normalized string", async () => {
    const [first, second] = await symbolsOf("export const { a, b } = m")
    if (first === undefined || second === undefined) throw new Error("two bindings expected")

    expect(normalizeAst(first)).toBe(normalizeAst(second))
  })

  it("marks an unexported destructuring internal, as it does a plain const", async () => {
    const symbols = await symbolsOf("const { a } = m")

    expect(symbols.map((s) => s.visibility)).toEqual(["internal"])
    expect(symbols[0]?.derivedBy).toEqual(["destructured-binding"])
  })

  it("is a const even when the value is a function, because nothing matches key to value", async () => {
    const symbols = await symbolsOf("export const { GET } = { GET: () => 1 }")

    expect(symbols.map((s) => s.kind)).toEqual(["const"])
    expect(symbols[0]?.signature).toBeNull()
  })

  it("prefixes each binding with the namespace it is declared in", async () => {
    expect(await idsOf("export namespace N { export const { a, b } = m }")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.a",
      "ts:src/a.ts#N.b",
    ])
  })
})

describe("a computed member name costs its member and nothing else", () => {
  it("keeps the class and every member that has a name", async () => {
    const ids = await idsOf("export class A { [Symbol.iterator]() {} m() {} }")

    expect(ids).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.m"])
  })

  it.each([
    ["a well-known symbol", "export class A { [Symbol.iterator]() {} }"],
    ["a string literal", 'export class A { ["go"]() {} }'],
    ["an expression", "export class A { [key + 1]() {} }"],
    ["a static computed member", "export class A { static [Symbol.iterator]() {} }"],
  ])("produces nothing for %s, and says nothing", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A"])
    expect((await importsOf(source)).errors).toEqual([])
  })
})

describe("an identifier outside ASCII names a Symbol", () => {
  it.each([
    ["a Japanese function", "export function ユーザー取得() {}", "ユーザー取得"],
    ["an accented function", "export function café() {}", "café"],
    ["a Japanese class", "export class クラス {}", "クラス"],
  ])("extracts %s", async (_label, source, name) => {
    expect(await idsOf(source)).toEqual([`ts:src/a.ts#${name}`])
  })

  it("keeps a whole file that mixes one with ordinary declarations, sorted by id", async () => {
    const ids = await idsOf("export function ユーザー取得() {}\nexport function ok() {}")

    expect(ids).toEqual(["ts:src/a.ts#ok", "ts:src/a.ts#ユーザー取得"])
  })
})
