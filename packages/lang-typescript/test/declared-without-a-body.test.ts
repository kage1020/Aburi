import { describe, expect, it } from "vitest"
import { byId, hintOf, symbolsOf } from "./fixtures/ctx"

const namesOf = async (source: string) => (await symbolsOf(source)).map((s) => s.name)

describe("abstract members", () => {
  it("an abstract method is a member beside the implemented ones", async () => {
    const symbols = await symbolsOf("export abstract class A { abstract doIt(): void; run() {} }")
    const doIt = byId(symbols, "#A.doIt")

    expect(symbols.map((s) => s.name)).toEqual(["A", "A.doIt", "A.run"])
    expect(doIt.kind).toBe("method")
    expect(doIt.derivedBy).toEqual(["class-method", "abstract-declaration"])
    expect(doIt.bodyNode).toBeNull()
  })

  it("carries the declared signature and the accessibility modifier", async () => {
    const symbols = await symbolsOf(
      "abstract class A { protected abstract price<T>(item: T, n: number): Promise<number> }",
    )
    const price = byId(symbols, "#A.price")

    expect(price.visibility).toBe("protected")
    expect(price.signature).toMatchObject({
      inputs: [
        { name: "item", type: "T" },
        { name: "n", type: "number" },
      ],
      outputs: ["Promise<number>"],
      typeParameters: ["T"],
    })
  })

  it("an abstract accessor pair is one member, led by the getter", async () => {
    const symbols = await symbolsOf(
      "abstract class A { abstract get v(): number; abstract set v(n: number) }",
    )
    const v = byId(symbols, "#A.v")

    expect(symbols.map((s) => s.name)).toEqual(["A", "A.v"])
    expect(v.signature?.outputs).toEqual(["number"])
    expect(v.derivedBy).toContain("accessor-declaration")
    expect(v.derivedBy).toContain("declaration-merged")
  })

  it("abstract overloads fold into one member, led by the first declaration", async () => {
    const symbols = await symbolsOf(
      "abstract class A { abstract f(x: string): void; abstract f(x: number): void }",
    )
    const f = byId(symbols, "#A.f")

    expect(symbols.map((s) => s.name)).toEqual(["A", "A.f"])
    expect(f.signature?.inputs).toEqual([{ name: "x", type: "string" }])
    expect(f.derivedBy).toEqual(["class-method", "abstract-declaration", "declaration-merged"])
  })

  it.each([
    ["the class, which is no longer a pure DTO", "ts:src/a.ts#A"],
    ["the method, which is not an empty body", "ts:src/a.ts#A.doIt"],
  ])("leaves %s without a hint", async (_label, id) => {
    expect(await hintOf("abstract class A { abstract doIt(): void }", id)).toBeNull()
  })

  it("a declare'd abstract class carries both tokens on one member", async () => {
    const symbols = await symbolsOf("declare abstract class C { abstract m(): void }")

    expect(symbols.map((s) => s.name)).toEqual(["C", "C.m"])
    expect(byId(symbols, "#C.m").derivedBy).toEqual([
      "class-method",
      "abstract-declaration",
      "ambient-declaration",
    ])
  })

  it("an abstract field is still a field, not a member", async () => {
    expect(await namesOf("abstract class A { abstract total: number }")).toEqual(["A"])
  })

  it("a member name the qualified-name grammar has no segment for is still no member", async () => {
    expect(
      await namesOf('abstract class A { abstract "a-b"(): void; abstract [k](): void }'),
    ).toEqual(["A"])
  })
})

describe("ambient declarations", () => {
  it("declare function declares a function, where a bare overload declares nothing", async () => {
    const f = byId(await symbolsOf("declare function f(): void"), "#f")

    expect(f.kind).toBe("function")
    expect(f.derivedBy).toEqual(["ambient-declaration"])
    expect(f.signature?.outputs).toEqual(["void"])
    expect(await namesOf("function f(x: string): void")).toEqual([])
  })

  it("export declare class carries the export and its members", async () => {
    const symbols = await symbolsOf("export declare class C { m(): void; static s(): number }")

    expect(symbols.map((s) => s.name)).toEqual(["C", "C.m", "C::s"])
    expect(byId(symbols, "#C").visibility).toBe("public")
    expect(byId(symbols, "#C").derivedBy).toEqual(["export-keyword", "ambient-declaration"])
    expect(byId(symbols, "#C.m").kind).toBe("method")
    expect(byId(symbols, "#C.m").derivedBy).toEqual(["class-method", "ambient-declaration"])
    expect(byId(symbols, "#C::s").derivedBy).toEqual(["static-method", "ambient-declaration"])
  })

  it("an ambient class body reads its constructor and accessors as it would a written one", async () => {
    const symbols = await symbolsOf("declare class C { constructor(a: string); get v(): number }")

    expect(byId(symbols, "#C.constructor").kind).toBe("constructor")
    expect(byId(symbols, "#C.v").derivedBy).toContain("accessor-declaration")
  })

  it("declare const, enum, interface and type each reach their own arm", async () => {
    const symbols = await symbolsOf(
      [
        "declare const x: number",
        "declare enum E { A }",
        "declare interface I { a: number }",
        "declare type T = number",
      ].join("\n"),
    )

    expect(
      symbols.map((s) => [s.name, s.kind, s.derivedBy.includes("ambient-declaration")]),
    ).toEqual([
      ["E", "enum", true],
      ["I", "interface", true],
      ["T", "type", true],
      ["x", "const", true],
    ])
  })

  it("declare namespace declares its body under the namespace", async () => {
    const symbols = await symbolsOf(
      "declare namespace N { function g(): void; class K { m(): void } }",
    )

    expect(symbols.map((s) => s.name)).toEqual(["N", "N.K", "N.K.m", "N.g"])
    expect(byId(symbols, "#N.g").derivedBy).toEqual(["ambient-declaration"])
    expect(byId(symbols, "#N.g").visibility).toBe("internal")
  })

  it("declare module with an identifier name is a namespace, exports and all", async () => {
    const symbols = await symbolsOf(
      "declare module Foo { export function g(): void; export class K { m(): void } }",
    )

    expect(symbols.map((s) => s.name)).toEqual(["Foo", "Foo.K", "Foo.K.m", "Foo.g"])
    expect(byId(symbols, "#Foo.g").derivedBy).toContain("export-keyword")
  })

  it("a dotted ambient namespace still declares one Symbol per segment", async () => {
    expect(await namesOf("declare namespace A.B { function g(): void }")).toEqual([
      "A",
      "A.B",
      "A.B.g",
    ])
  })

  it("JSDoc above an ambient declaration is read as its own", async () => {
    const h = byId(
      await symbolsOf("/** @throws PaymentDeclined */\nexport declare function h(): void"),
      "#h",
    )

    expect(h.signature?.throws).toEqual(["PaymentDeclined"])
    expect(h.visibility).toBe("public")
  })

  it.each([
    ["export declare const x: number", "#x"],
    ["export declare enum E { A }", "#E"],
    ["export declare interface I { a: number }", "#I"],
    ["export declare type T = number", "#T"],
    ["export declare namespace N { }", "#N"],
    ["export declare abstract class C { }", "#C"],
    ["export declare function f(): void", "#f"],
  ])("export declare reads as exported: %s", async (source, suffix) => {
    const symbol = byId(await symbolsOf(source), suffix)

    expect(symbol.visibility).toBe("public")
    expect(symbol.derivedBy).toContain("export-keyword")
    expect(symbol.derivedBy).toContain("ambient-declaration")
  })

  it.each([
    [
      "a declared function, which is not an empty body",
      "declare function f(): void",
      "ts:src/a.ts#f",
    ],
    [
      "a declared method, which is not an empty body",
      "declare class C { m(): void }",
      "ts:src/a.ts#C.m",
    ],
    [
      "a class of method signatures, which is not a pure DTO",
      "declare class C { m(): void }",
      "ts:src/a.ts#C",
    ],
  ])("leaves %s without a hint", async (_label, source, id) => {
    expect(await hintOf(source, id)).toBeNull()
  })

  it("a nested declare stamps the token once, not twice", async () => {
    const g = byId(await symbolsOf("declare namespace N { declare function g(): void }"), "#N.g")

    expect(g.derivedBy).toEqual(["ambient-declaration"])
  })

  it.each([
    ["a namespace the parser had to name", "declare namespace"],
    ["a module the parser had to name", "declare module"],
    [
      "one the parser had to name, before a declaration",
      "declare namespace\nexport function keep() {}",
    ],
    ["a quoted module name", 'module "express" { }'],
    ["a module augmentation", 'declare module "express" { interface Request { user: string } }'],
    ["declare global", "declare global { interface Window { app: string } }"],
  ])("declares nothing for %s, and costs the file nothing", async (_label, source) => {
    const names = await namesOf(`export function local() {}\n${source}`)

    expect(names).toContain("local")
    expect(names.filter((name) => name !== "local" && name !== "keep")).toEqual([])
  })
})
