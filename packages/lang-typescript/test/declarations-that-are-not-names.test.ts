import { describe, expect, it } from "vitest"
import { langTypescriptManifest } from "../src/index"
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

  it("reads the value side of a rename, not the key being read from", async () => {
    expect(await idsOf("export const { a: b } = m")).toEqual(["ts:src/a.ts#b"])
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

  it("gives every binding the kind and range a plain const gets", async () => {
    const symbols = await symbolsOf("export const { GET, POST } = handlers")

    expect(symbols.map((s) => s.kind)).toEqual(["const", "const"])
    expect(symbols.map((s) => s.visibility)).toEqual(["public", "public"])
    expect(symbols[0]?.source.startLine).toBe(1)
    expect(symbols[1]?.source.startLine).toBe(1)
    for (const symbol of symbols) {
      expect(symbol.derivedBy).toContain("destructured-binding")
      expect(symbol.derivedBy).toContain("export-keyword")
    }
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

  it("leaves a plain const exactly as it was", async () => {
    const symbols = await symbolsOf("export const x = 1")

    expect(symbols.map((s) => s.id)).toEqual(["ts:src/a.ts#x"])
    expect(symbols[0]?.kind).toBe("const")
    expect(symbols[0]?.derivedBy).toEqual(["export-keyword"])
  })

  it("leaves a variable-assigned arrow exactly as it was", async () => {
    const symbols = await symbolsOf("export const f = () => 1")

    expect(symbols.map((s) => s.kind)).toEqual(["function"])
    expect(symbols[0]?.derivedBy).toContain("variable-assigned-function")
  })

  it("prefixes each binding with the namespace it is declared in", async () => {
    expect(await idsOf("export namespace N { export const { a, b } = m }")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.a",
      "ts:src/a.ts#N.b",
    ])
  })
})

describe("every rationale extraction emits is one the manifest declares", () => {
  it.each([
    ["export const { a } = m", ["destructured-binding"]],
    ["export const x = 1", ["export-keyword"]],
    ["export const f = () => 1", ["variable-assigned-function", "export-keyword"]],
    ["export class A { m() {} }", ["export-keyword", "class-method"]],
    ["export class A { static m() {} }", ["static-method"]],
    ["export class A { constructor() {} }", ["constructor-declaration"]],
    ["export interface I {}", ["interface-declaration", "export-keyword"]],
    ["export type T = 1", ["type-alias", "export-keyword"]],
    ["export enum E { A }", ["enum-declaration", "export-keyword"]],
    ["export namespace N {}", ["namespace-declaration", "export-keyword"]],
    ["export declare interface I {}", ["interface-declaration", "export-keyword"]],
    ["export default function () {}", ["export-default"]],
    ["export default interface I {}", ["interface-declaration", "export-default"]],
    ["export class A { get v() { return 1 } }", ["accessor-declaration"]],
    [
      "export class A { get v() { return 1 } set v(n) {} }",
      ["accessor-declaration", "declaration-merged"],
    ],
    ["export abstract class A { abstract m(): void }", ["abstract-declaration"]],
    ["export declare function f(): void", ["ambient-declaration"]],
    [
      "export const o = { m() {}, f: () => {} }",
      ["object-literal-initializer", "object-method", "property-assigned-function"],
    ],
  ])("declares the rationales %s produces", async (source, expected) => {
    const declared = new Set(langTypescriptManifest.provides.derivedByPrefixes)
    const emitted = (await symbolsOf(source)).flatMap((s) => s.derivedBy)

    expect(emitted).toEqual(expect.arrayContaining(expected))
    for (const token of emitted) {
      expect(declared.has(token)).toBe(true)
    }
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

describe("an identifier the grammar refused is a Symbol now", () => {
  it.each([
    ["a Japanese function", "export function ユーザー取得() {}", "ユーザー取得"],
    ["an accented function", "export function café() {}", "café"],
    ["a Japanese class", "export class クラス {}", "クラス"],
  ])("extracts %s", async (_label, source, name) => {
    expect(await idsOf(source)).toEqual([`ts:src/a.ts#${name}`])
  })

  it("keeps a whole file that mixes one with ordinary declarations", async () => {
    const ids = await idsOf("export function ユーザー取得() {}\nexport function ok() {}")

    // Sorted by id, which is how `extractSymbols` returns them — not source order.
    expect(ids).toEqual(["ts:src/a.ts#ok", "ts:src/a.ts#ユーザー取得"])
  })
})
