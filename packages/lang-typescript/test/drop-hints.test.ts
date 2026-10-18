import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifySymbolDropHint } from "../src/index"
import { classOf, hintOf, makeExtractionCtx, symbolOf } from "./fixtures/ctx"
import { scanWithoutWarnings } from "./fixtures/scan"

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

describe("what a member beside a field makes of the class", () => {
  it.each([
    ["a static block", "static { load() }"],
    ["a getter", "get total() { return 0 }"],
    ["a setter", "set total(n: number) {}"],
    ["a constructor", "constructor() {}"],
  ])("keeps a class of a field and %s", async (_label, member) => {
    expect(await hintOf(classOf("  id = ''", `  ${member}`), "ts:src/a.ts#C")).toBeNull()
  })

  it.each([
    ["an index signature", "[key: string]: unknown"],
    ["a declared field", "declare total: number"],
    ["an auto-accessor", "accessor total = 0"],
    ["a field whose initializer calls", "seed = compute()"],
    ["a comment", "// the rest is data"],
  ])("still hints a class of a field and %s as a pure DTO", async (_label, member) => {
    expect(await hintOf(classOf("  id = ''", `  ${member}`), "ts:src/a.ts#C")).toEqual(
      B("pure DTO"),
    )
  })

  it.each([
    ["a doc comment", "/** the second */"],
    ["a line comment", "// the second"],
    ["a stray semicolon", ";"],
  ])("still hints a class of constants and %s as pure constants", async (_label, member) => {
    const source = classOf("  static readonly A = 1", `  ${member}`, "  static readonly B = 2")

    expect(await hintOf(source, "ts:src/a.ts#C")).toEqual(B("pure constants"))
  })

  it("hints a class of constants and an index signature as a pure DTO", async () => {
    const source = classOf("  static readonly A = 1", "  [key: string]: unknown")

    expect(await hintOf(source, "ts:src/a.ts#C")).toEqual(B("pure DTO"))
  })
})

describe("scan — a static block is code its class carries", () => {
  const workspace = useScratchWorkspace("static-block")
  const FIELD = "  static items: string[] = []"
  const BLOCK = "  static {\n    prisma.user.deleteMany()\n  }"

  async function scanRegistry(...members: string[]) {
    const source = [
      'import { PrismaClient } from "@prisma/client"',
      "const prisma = new PrismaClient()",
      "",
      "export class Registry {",
      ...members,
      "}",
      "",
    ].join("\n")
    await workspace.writeSource("src/registry.ts", source)
    const registry = symbolById(
      { ir: await scanWithoutWarnings(workspace.root) },
      "ts:src/registry.ts#Registry",
    )
    const { dropped, dropReason, calls } = registry
    return { dropped, dropReason, calls: calls.map((c) => c.target) }
  }

  it.each([
    ["a field and a static block", [FIELD, BLOCK]],
    ["a static block alone", [BLOCK]],
  ])("keeps a class of %s, with the block's calls on it", async (_label, members) => {
    expect(await scanRegistry(...members)).toEqual({
      dropped: false,
      dropReason: null,
      calls: ["prisma.user.deleteMany"],
    })
  })

  it("drops the class of the field alone as a pure DTO", async () => {
    expect(await scanRegistry(FIELD)).toEqual({
      dropped: true,
      dropReason: "pure DTO",
      calls: [],
    })
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
