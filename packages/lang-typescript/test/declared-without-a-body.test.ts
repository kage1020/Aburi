import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifySymbolDropHint, extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * The two statement shapes a declaration with **no body** is written in: `abstract` inside a
 * class, and `declare` at statement position. Both were absent from the extractor, so an
 * abstract class reported only the methods it happened to implement, and every `declare` form
 * — `declare function`, `export declare class`, `declare namespace` — produced no Symbol at all
 * in the ordinary `.ts` files that are not dropped as `.d.ts` (LP29, LP30).
 */

async function symbolsOf(source: string): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source))
}

function names(symbols: SymbolCandidate<Node>[]): string[] {
  return symbols.map((s) => s.name)
}

function byId(symbols: SymbolCandidate<Node>[], suffix: string): SymbolCandidate<Node> {
  const match = symbols.find((s) => s.id.endsWith(suffix))
  if (match === undefined) {
    throw new Error(
      `no symbol with id ending in "${suffix}" (have: ${symbols.map((s) => s.id).join(", ")})`,
    )
  }
  return match
}

describe("LP29: abstract members", () => {
  it("an abstract method is a member beside the implemented ones", async () => {
    const symbols = await symbolsOf("export abstract class A { abstract doIt(): void; run() {} }")
    expect(names(symbols).sort()).toEqual(["A", "A.doIt", "A.run"])
    const doIt = byId(symbols, "#A.doIt")
    expect(doIt.kind).toBe("method")
    expect(doIt.derivedBy).toContain("class-method")
    expect(doIt.derivedBy).toContain("abstract-declaration")
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
    expect(names(symbols).sort()).toEqual(["A", "A.v"])
    const v = byId(symbols, "#A.v")
    expect(v.signature?.outputs).toEqual(["number"])
    expect(v.derivedBy).toContain("accessor-declaration")
    expect(v.derivedBy).toContain("declaration-merged")
  })

  it("abstract overloads fold into one member", async () => {
    const symbols = await symbolsOf(
      "abstract class A { abstract f(x: string): void; abstract f(x: number): void }",
    )
    expect(names(symbols).sort()).toEqual(["A", "A.f"])
  })

  it("the class is no longer a pure DTO once its only members are abstract", async () => {
    const symbols = await symbolsOf("abstract class A { abstract doIt(): void }")
    const ctx = makeExtractionCtx("src/a.ts", "")
    expect(classifySymbolDropHint(byId(symbols, "#A"), ctx)).toBeNull()
  })

  it("an abstract method is not an empty body", async () => {
    const symbols = await symbolsOf("abstract class A { abstract doIt(): void }")
    const ctx = makeExtractionCtx("src/a.ts", "")
    expect(classifySymbolDropHint(byId(symbols, "#A.doIt"), ctx)).toBeNull()
  })

  it("an abstract field is still a field, not a member", async () => {
    const symbols = await symbolsOf("abstract class A { abstract total: number }")
    expect(names(symbols)).toEqual(["A"])
  })
})

describe("LP30: ambient declarations", () => {
  it("declare function is the declaration, where a bare overload is not", async () => {
    const symbols = await symbolsOf("declare function f(): void")
    const f = byId(symbols, "#f")
    expect(f.kind).toBe("function")
    expect(f.derivedBy).toContain("ambient-declaration")
    expect(f.signature?.outputs).toEqual(["void"])
  })

  it("a top-level overload beside its implementation is still one Symbol", async () => {
    const symbols = await symbolsOf("function f(x: string): void\nfunction f(x: unknown) {}")
    expect(names(symbols)).toEqual(["f"])
    expect(byId(symbols, "#f").derivedBy).not.toContain("ambient-declaration")
  })

  it("a bare overload with no implementation declares nothing", async () => {
    expect(names(await symbolsOf("function f(x: string): void"))).toEqual([])
  })

  it("export declare class carries the export and its members", async () => {
    const symbols = await symbolsOf("export declare class C { m(): void; static s(): number }")
    expect(names(symbols).sort()).toEqual(["C", "C.m", "C::s"])
    const c = byId(symbols, "#C")
    expect(c.visibility).toBe("public")
    expect(c.derivedBy).toContain("export-keyword")
    expect(c.derivedBy).toContain("ambient-declaration")
    const m = byId(symbols, "#C.m")
    expect(m.kind).toBe("method")
    expect(m.derivedBy).toContain("ambient-declaration")
    expect(byId(symbols, "#C::s").derivedBy).toContain("static-method")
  })

  it("an ambient class body reads its constructor and accessors as it would a written one", async () => {
    const symbols = await symbolsOf("declare class C { constructor(a: string); get v(): number }")
    expect(byId(symbols, "#C.constructor").kind).toBe("constructor")
    expect(byId(symbols, "#C.v").derivedBy).toContain("accessor-declaration")
  })

  it("a method_signature in an ordinary class body stays an overload", async () => {
    const symbols = await symbolsOf("class C { m(x: string): void; m(x: unknown) { return x } }")
    expect(names(symbols).sort()).toEqual(["C", "C.m"])
    expect(byId(symbols, "#C.m").bodyNode).not.toBeNull()
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
    expect(byId(symbols, "#x").kind).toBe("const")
    expect(byId(symbols, "#E").kind).toBe("enum")
    expect(byId(symbols, "#I").kind).toBe("interface")
    expect(byId(symbols, "#T").kind).toBe("type")
    for (const suffix of ["#x", "#E", "#I", "#T"]) {
      expect(byId(symbols, suffix).derivedBy).toContain("ambient-declaration")
    }
  })

  it("declare namespace declares its body under the namespace", async () => {
    const symbols = await symbolsOf(
      "declare namespace N { function g(): void; class K { m(): void } }",
    )
    expect(names(symbols).sort()).toEqual(["N", "N.K", "N.K.m", "N.g"])
    expect(byId(symbols, "#N.g").derivedBy).toContain("ambient-declaration")
  })

  it("declare module with an identifier name is a namespace, exports and all", async () => {
    const symbols = await symbolsOf(
      "declare module Foo { export function g(): void; export class K { m(): void } }",
    )
    expect(names(symbols).sort()).toEqual(["Foo", "Foo.K", "Foo.K.m", "Foo.g"])
    expect(byId(symbols, "#Foo.g").derivedBy).toContain("export-keyword")
  })

  it("a dotted ambient namespace still declares one Symbol per segment", async () => {
    const symbols = await symbolsOf("declare namespace A.B { function g(): void }")
    expect(names(symbols).sort()).toEqual(["A", "A.B", "A.B.g"])
  })

  it("a member name the qualified-name grammar has no segment for is still no member", async () => {
    const symbols = await symbolsOf(
      'abstract class A { abstract "a-b"(): void; abstract [k](): void }',
    )
    expect(names(symbols)).toEqual(["A"])
  })

  it("JSDoc above an ambient declaration is read as its own", async () => {
    const symbols = await symbolsOf(
      "/** @throws PaymentDeclined */\nexport declare function h(): void",
    )
    expect(byId(symbols, "#h").signature?.throws).toEqual(["PaymentDeclined"])
  })

  it("a module augmentation declares nothing, and costs the file nothing", async () => {
    const symbols = await symbolsOf(
      'export function local() {}\ndeclare module "express" { interface Request { user: string } }',
    )
    expect(names(symbols)).toEqual(["local"])
  })

  it("declare global declares nothing, and costs the file nothing", async () => {
    const symbols = await symbolsOf(
      "export function local() {}\ndeclare global { interface Window { app: string } }",
    )
    expect(names(symbols)).toEqual(["local"])
  })
})
