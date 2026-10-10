import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { idsOf, normalizedOf, symbolOf, walkOf } from "./fixtures/ctx"

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

const stringOf = (lines: readonly string[], id: string) => normalizedOf(lines.join("\n"), id)

async function expectDistinctIds(source: string): Promise<void> {
  const ids = await idsOf(source)
  expect(new Set(ids).size).toBe(ids.length)
}

describe("an overload signature beside its implementation", () => {
  it("is one Symbol led by the implementation, carrying the overloads", async () => {
    const parse = await symbolOf(PARSE.join("\n"), "ts:src/a.ts#parse")

    expect(parse.signature?.inputs).toEqual([{ name: "input", type: "any" }])
    expect(parse.source.startLine).toBe(4)
    expect(parse.derivedBy).toEqual(["export-keyword", "declaration-merged"])
    expect(parse.mergedDeclarations?.map((d) => d.fullNode.text)).toEqual([
      "function parse(input: string): Config;",
      "function parse(input: Buffer): Config;",
    ])
    await expectDistinctIds(PARSE.join("\n"))
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
    expect(find.source.startLine).toBe(4)
    expect(find.derivedBy).toEqual(["class-method", "declaration-merged"])
    expect(find.mergedDeclarations?.map((d) => d.fullNode.text)).toEqual([
      "find(id: string): User",
      "find(id: number): User",
    ])
    await expectDistinctIds(FIND.join("\n"))

    const removed = FIND.filter((line) => !line.includes("id: number"))
    expect(await stringOf(removed, "ts:src/a.ts#R.find")).not.toBe(
      await stringOf(FIND, "ts:src/a.ts#R.find"),
    )
  })

  it.each([
    [
      "a constructor",
      "export class K { constructor(a: string); constructor(a: any) { init() } }",
      "ts:src/a.ts#K.constructor",
      { kind: "constructor", visibility: "public" },
    ],
    [
      "a static method",
      "export class K { static m(a: string): void; static m(a: any) { s() } }",
      "ts:src/a.ts#K::m",
      { kind: "method", visibility: "public" },
    ],
    [
      "a #-private method",
      "export class K { #m(a: string): void; #m(a: any) { p() } }",
      "ts:src/a.ts#K.#m",
      { kind: "method", visibility: "private" },
    ],
    [
      "a generator method",
      "export class K { *m(a: string): Iterable<string>; *m(a: any) { yield a } }",
      "ts:src/a.ts#K.m",
      { kind: "method", visibility: "public" },
    ],
    [
      "a function in a namespace",
      "export namespace N { export function f(a: string): void; export function f(a: any) { q() } }",
      "ts:src/a.ts#N.f",
      { kind: "function", visibility: "public" },
    ],
  ])("folds %s's overload under the id its implementation has", async (_label, source, id, scalars) => {
    const symbol = await symbolOf(source, id)
    expect(symbol).toMatchObject(scalars)
    expect(symbol.bodyNode).not.toBeNull()
    expect(symbol.signature?.inputs).toEqual([{ name: "a", type: "any" }])
    expect(symbol.mergedDeclarations?.map((d) => d.bodyNode)).toEqual([null])
    await expectDistinctIds(source)

    const retyped = source.replace("(a: string)", "(a: number)")
    expect(normalizeAst(await symbolOf(retyped, id))).not.toBe(normalizeAst(symbol))
  })

  it("gives overloads with no implementation no Symbol, as tsc refuses them", async () => {
    expect(await idsOf("export function lone(a: string): void;\n")).toEqual([])
    expect(await idsOf("export class S {\n  m(a: string): void;\n}\n")).toEqual(["ts:src/a.ts#S"])
  })

  it("folds an overload with no implementation into another declaration of its name", async () => {
    const source = "function f(a: string): void;\nnamespace f { export const x = 1 }\n"
    const f = await symbolOf(source, "ts:src/a.ts#f")
    expect(f.kind).toBe("namespace")
    expect(f.mergedDeclarations?.map((d) => d.fullNode.type)).toEqual(["function_signature"])
  })

  it("leaves an ambient overload set led by its first declaration", async () => {
    const declared = await symbolOf(
      "declare function g(a: string): void;\ndeclare function g(a: number): void;\n",
      "ts:src/a.ts#g",
    )
    expect(declared.signature?.inputs).toEqual([{ name: "a", type: "string" }])
  })

  it("does not fold a module-level generator's overloads, which the grammar cannot parse", async () => {
    const source = [
      "export function* g(a: string): Iterable<string>;",
      "export function* g(a: any) { yield a }",
      "",
    ].join("\n")
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#g"])
    expect((await symbolOf(source, "ts:src/a.ts#g")).mergedDeclarations).toBeUndefined()
  })
})

describe("a bodyless accessor signature, which tsc rejects outside a declare", () => {
  it("leaves the member to the setter beside it, body and all", async () => {
    const source = "class C { get x(): number; set x(v: number) { store(v) } }"
    const x = await symbolOf(source, "ts:src/a.ts#C.x")

    expect(x.fullNode.text).toBe("set x(v: number) { store(v) }")
    expect(x.signature?.inputs).toEqual([{ name: "v", type: "number" }])
    expect((await walkOf(source, "ts:src/a.ts#C.x")).calls.map((c) => c.target)).toEqual(["store"])
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

describe("what an overload's parameter list holds", () => {
  it("stays on the class, which reads the signature whole", async () => {
    const source =
      "class C { m(@Inject() a: string): void; m(a = compute()): void; m(a: any) { log(a) } }"

    expect((await walkOf(source, "ts:src/a.ts#C")).calls.map((c) => c.target)).toEqual([
      "Inject",
      "compute",
    ])
    expect((await walkOf(source, "ts:src/a.ts#C.m")).calls.map((c) => c.target)).toEqual(["log"])
  })
})
