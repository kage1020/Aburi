import { describe, expect, it } from "vitest"
import { classifySymbolDropHint } from "../src/index"
import { hintOf, makeExtractionCtx, symbolOf } from "./fixtures/ctx"

const B = (reason: string) => ({ reason, category: "B" })

describe("classifySymbolDropHint", () => {
  it.each([
    ["an interface", "export interface I { total: number }", "I", B("interface (data model)")],
    ["a type alias", "export type T = number", "T", B("type alias")],
    ["an empty function", "export function f() {}", "f", B("empty body")],
    [
      "a function holding only a comment",
      "export function f() { /* later */ }",
      "f",
      B("empty body"),
    ],
    ["a function that only returns a literal", "export function f() { return 1 }", "f", null],
  ])("hints %s", async (_label, source, name, hint) => {
    expect(await hintOf(source, `ts:src/a.ts#${name}`)).toEqual(hint)
  })
})

describe("a class with no method is data", () => {
  it.each([
    ["fields alone", "export class C { total: number = 0 }", B("pure DTO")],
    [
      "static readonly literals",
      "export class C { static readonly PI = 3.14; static readonly E = 2.72 }",
      B("pure constants"),
    ],
    [
      "literals that are only readonly or only static",
      "export class C { readonly A = 1; static B = 'x' }",
      B("pure constants"),
    ],
    [
      "a template and a regex as literals",
      "export class C { static readonly A = `a`; static readonly R = /r/ }",
      B("pure constants"),
    ],
    [
      "a static readonly field holding a call",
      "export class C { static readonly A = make() }",
      B("pure DTO"),
    ],
    [
      "a plain field holding a literal",
      "export class C { static readonly A = 1; b = 2 }",
      B("pure DTO"),
    ],
    ["a method", "export class C { create() { return 1 } }", null],
    [
      "a method in a second declaration of the class",
      "export class C { a = 1 }\nexport class C { m() {} }",
      null,
    ],
  ])("hints a class of %s", async (_label, source, hint) => {
    expect(await hintOf(source, "ts:src/a.ts#C")).toEqual(hint)
  })

  it.each([
    [
      "constants",
      "export class P { static readonly A = 1 }\nexport interface P { b: string }",
      B("pure constants"),
    ],
    ["a DTO", "export class P { a: string = '' }\nexport interface P { m(): void }", B("pure DTO")],
  ])("reads only the class bodies of %s merged with an interface", async (_label, source, hint) => {
    expect(await hintOf(source, "ts:src/a.ts#P")).toEqual(hint)
  })
})

describe("a boundary decorator", () => {
  it.each([
    ["an interface", "export interface I { a: number }", "ts:src/a.ts#I"],
    ["a type alias", "export type T = number", "ts:src/a.ts#T"],
    ["a class of fields", "export class C { a = 1 }", "ts:src/a.ts#C"],
    ["an empty method", "export class C { m() {} }", "ts:src/a.ts#C.m"],
    ["an empty function", "export function f() {}", "ts:src/a.ts#f"],
  ])("keeps %s, which would otherwise be hinted", async (_label, source, id) => {
    const symbol = await symbolOf(source, id)
    const ctx = makeExtractionCtx("src/a.ts", source)
    const boundary = {
      name: "Controller",
      raw: "Controller()",
      arguments: [],
      boundary: true,
      line: 1,
    }

    expect(classifySymbolDropHint(symbol, ctx)).not.toBeNull()
    expect(classifySymbolDropHint({ ...symbol, decorators: [boundary] }, ctx)).toBeNull()
  })
})
