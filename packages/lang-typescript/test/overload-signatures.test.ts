import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { idsOf, symbolOf, walkOf } from "./fixtures/ctx"

/**
 * An overload signature folds into its implementation's Symbol as a declaration with no body,
 * so the syntax axis sees the overload set; the implementation still leads (LP8f, LP8q). Dropped
 * outright, adding, removing or retyping an overload was no change on any axis.
 */

const PARSE = [
  "export interface Config { name: string }",
  "export function parse(input: string): Config;",
  "export function parse(input: Buffer): Config;",
  "export function parse(input: any): any {",
  "  return decode(input)",
  "}",
  "",
]

const FIND = [
  "export class R {",
  "  find(id: string): User;",
  "  find(id: number): User;",
  "  find(id: any): any { return load(id) }",
  "}",
  "",
]

async function stringOf(lines: readonly string[], id: string): Promise<string> {
  return normalizeAst(await symbolOf(lines.join("\n"), id))
}

describe("an overload signature beside its implementation", () => {
  it("is one Symbol led by the implementation, carrying the overloads", async () => {
    const parse = await symbolOf(PARSE.join("\n"), "ts:src/a.ts#parse")

    expect(parse.signature?.inputs).toEqual([{ name: "input", type: "any" }])
    expect(parse.source.startLine).toBe(4)
    expect(parse.derivedBy).toContain("declaration-merged")
    expect(parse.mergedDeclarations?.map((d) => d.fullNode.text)).toEqual([
      "function parse(input: string): Config;",
      "function parse(input: Buffer): Config;",
    ])
  })

  it.each([
    ["removing an overload", PARSE.filter((line) => !line.includes("Buffer"))],
    [
      "changing an overload's return type",
      PARSE.map((line) =>
        line.replace("(input: string): Config", "(input: string): Config | null"),
      ),
    ],
    [
      "changing an overload's parameter",
      PARSE.map((line) => line.replace("(input: Buffer)", "(input: Uint8Array)")),
    ],
  ])("changes the normalized string on %s", async (_label, edited) => {
    expect(await stringOf(edited, "ts:src/a.ts#parse")).not.toBe(
      await stringOf(PARSE, "ts:src/a.ts#parse"),
    )
  })

  it("does the same for a method's overloads in a class", async () => {
    const find = await symbolOf(FIND.join("\n"), "ts:src/a.ts#R.find")
    expect(find.signature?.inputs).toEqual([{ name: "id", type: "any" }])
    expect(find.mergedDeclarations).toHaveLength(2)

    const removed = FIND.filter((line) => !line.includes("id: number"))
    expect(await stringOf(removed, "ts:src/a.ts#R.find")).not.toBe(
      await stringOf(FIND, "ts:src/a.ts#R.find"),
    )
  })

  it("gives overloads with no implementation no Symbol, as tsc's TS2391 has it", async () => {
    expect(await idsOf("export function lone(a: string): void;\n")).toEqual([])
    expect(await idsOf("export class S {\n  m(a: string): void;\n}\n")).toEqual(["ts:src/a.ts#S"])
  })

  it("leaves an ambient overload set led by its first declaration", async () => {
    const declared = await symbolOf(
      "declare function g(a: string): void;\ndeclare function g(a: number): void;\n",
      "ts:src/a.ts#g",
    )
    expect(declared.signature?.inputs).toEqual([{ name: "a", type: "string" }])
  })
})

describe("a bodyless accessor signature, which tsc rejects outside a declare", () => {
  it("leaves the member to the setter beside it, body and all", async () => {
    const source = "class C { get x(): number; set x(v: number) { store(v) } }"
    const x = await symbolOf(source, "ts:src/a.ts#C.x")

    expect(x.fullNode.text).toBe("set x(v: number) { store(v) }")
    expect(x.signature?.inputs).toEqual([{ name: "v", type: "number" }])
    expect((await walkOf(source, "ts:src/a.ts#C.x")).calls.map((c) => c.target)).toEqual(["store"])
    // The class skips the setter's body because the member carries it, so it has none.
    expect((await walkOf(source, "ts:src/a.ts#C")).calls).toEqual([])
  })

  it("leaves the member to the getter with a body", async () => {
    const source = "class C { get x(): number; get x() { return mk() } }"
    const x = await symbolOf(source, "ts:src/a.ts#C.x")

    expect(x.fullNode.text).toBe("get x() { return mk() }")
    expect(x.mergedDeclarations?.map((d) => d.bodyNode)).toEqual([null])
    expect((await walkOf(source, "ts:src/a.ts#C.x")).calls.map((c) => c.target)).toEqual(["mk"])
  })

  it("declares no member on its own", async () => {
    expect(await idsOf("class C { get x(): number; }")).toEqual(["ts:src/a.ts#C"])
  })
})
