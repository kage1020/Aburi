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
 * in the ordinary `.ts` files that are not dropped as `.d.ts` (LP35, LP36).
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

describe("LP35: abstract members", () => {
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

  it("abstract overloads fold into one member, led by the first declaration", async () => {
    const symbols = await symbolsOf(
      "abstract class A { abstract f(x: string): void; abstract f(x: number): void }",
    )
    expect(names(symbols).sort()).toEqual(["A", "A.f"])
    const f = byId(symbols, "#A.f")
    expect(f.derivedBy).toContain("declaration-merged")
    // LP8f takes the signature from the implementation, and an abstract pair has none — so the
    // leading declaration is what the Symbol reports, which is the answer LP35 records.
    expect(f.signature?.inputs).toEqual([{ name: "x", type: "string" }])
    expect(f.derivedBy.filter((t) => t === "abstract-declaration")).toHaveLength(1)
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

  it("a declare\u0027d abstract class carries both tokens on one member", async () => {
    const symbols = await symbolsOf("declare abstract class C { abstract m(): void }")
    expect(names(symbols).sort()).toEqual(["C", "C.m"])
    const m = byId(symbols, "#C.m")
    expect(m.derivedBy).toContain("abstract-declaration")
    expect(m.derivedBy).toContain("ambient-declaration")
  })

  it("an abstract field is still a field, not a member", async () => {
    const symbols = await symbolsOf("abstract class A { abstract total: number }")
    expect(names(symbols)).toEqual(["A"])
  })
})

describe("LP36: ambient declarations", () => {
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
    // The divergence LP36 records: `tsc` resolves `N.g` from outside, because an ambient
    // namespace exports its members with or without the keyword. Visibility here is read off
    // the statement, so a member written without `export` answers `internal`. Pinned so the
    // answer is a decision rather than a side effect.
    expect(byId(symbols, "#N.g").visibility).toBe("internal")
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
    expect(byId(symbols, "#h").visibility).toBe("public")
  })

  // `statementParent` is what makes `export declare` read as exported, and the node handed to
  // it differs by kind — `addNamespaceAndBody` passes the `module`, `makeVariableCandidate` the
  // enclosing `lexical_declaration` — so one kind passing does not carry the others.
  //
  // `visibility` is the whole assertion. Which builders also push `export-keyword` onto
  // `derivedBy` is a separate and older asymmetry: the interface, type alias, enum and
  // namespace builders have never emitted it, exported or not, and evening that out is not
  // this change's business.
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
    expect(symbol.derivedBy).toContain("ambient-declaration")
  })

  it("an ambient declaration is not an empty body", async () => {
    const ctx = makeExtractionCtx("src/a.ts", "")
    const fn = byId(await symbolsOf("declare function f(): void"), "#f")
    expect(classifySymbolDropHint(fn, ctx)).toBeNull()
    const method = byId(await symbolsOf("declare class C { m(): void }"), "#C.m")
    expect(classifySymbolDropHint(method, ctx)).toBeNull()
  })

  it("an ambient class with only method signatures is not a pure DTO", async () => {
    const symbols = await symbolsOf("declare class C { m(): void }")
    expect(
      classifySymbolDropHint(byId(symbols, "#C"), makeExtractionCtx("src/a.ts", "")),
    ).toBeNull()
  })

  it("a nested declare stamps the token once, not twice", async () => {
    const symbols = await symbolsOf("declare namespace N { declare function g(): void }")
    const g = byId(symbols, "#N.g")
    expect(g.derivedBy.filter((t) => t === "ambient-declaration")).toHaveLength(1)
  })

  it("a namespace the parser had to name declares nothing, and costs the file nothing", async () => {
    for (const source of [
      "declare namespace",
      "declare module",
      "declare module\nexport function keep() {}",
      "declare namespace\nexport function keep() {}",
    ]) {
      const symbols = await symbolsOf(`export function local() {}\n${source}`)
      expect(names(symbols)).toContain("local")
      expect(names(symbols)).not.toContain("export")
    }
  })

  it("a quoted module name is refused with or without the declare", async () => {
    // `module "express" {}` parses without a `declare`, so this arm was reachable before the
    // wrapper was read through — the grammar decides what gets here, not `tsc`.
    const symbols = await symbolsOf('export function local() {}\nmodule "express" { }')
    expect(names(symbols)).toEqual(["local"])
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
