import type { BodyExtraction, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import {
  classifySymbolDropHint,
  extractSymbols,
  normalizeAst,
  parseTypescriptFile,
  walkBody,
} from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * Three ordinary TypeScript constructs declare one entity twice — an accessor pair, an
 * overload beside its implementation, and a merged declaration. Extraction answered one
 * SymbolCandidate per *declaration*, so each produced two Symbols with one id, and integrity
 * invariant #1 refused the document. That check runs once over the whole scan, so a single
 * `get`/`set` pair ended the run rather than costing its own file.
 *
 * TypeScript models all three the same way: one entity, several declarations. So does this
 * now. The first declaration claims the Symbol and every scalar on it; the rest contribute
 * their rationale and their body.
 */

async function symbolsOf(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source))
}

async function idsOf(source: string): Promise<string[]> {
  return (await symbolsOf(source)).map((s) => s.id)
}

async function symbolNamed(source: string, id: string) {
  const found = (await symbolsOf(source)).find((s) => s.id === id)
  if (found === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return found
}

async function walkOf(source: string, id: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
  return walkBody(target, walkCtx)
}

describe("an overload declaration declares nothing the implementation does not", () => {
  it.each([
    ["a method", "export class Repo { find(id: string): number; find(id: any) { return 1 } }"],
    [
      "three overloads",
      "export class R { f(a: string): void; f(a: number): void; f(a: any) { g() } }",
    ],
    ["a constructor", "export class K { constructor(a: string); constructor(a: any) {} }"],
  ])("emits one Symbol for %s", async (_label, source) => {
    const ids = await idsOf(source)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("takes the signature and the body from the implementation", async () => {
    // The overload sits first in source order, so a rule that kept the first declaration
    // would report the Symbol as bodyless and give it the overload's parameter types.
    const source = "export class Repo { find(id: string): number; find(id: any) { return 1 } }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#Repo.find")

    expect(symbol.kind).toBe("method")
    expect(symbol.signature?.inputs).toEqual([{ name: "id", type: "any" }])
    expect(symbol.bodyNode?.type).toBe("statement_block")
  })

  it("keeps the constructor kind on a constructor's implementation", async () => {
    const source = "export class K { constructor(a: string); constructor(a: any) {} }"
    expect((await symbolNamed(source, "ts:src/a.ts#K.constructor")).kind).toBe("constructor")
  })

  it("emits no member for a declaration with no implementation", async () => {
    // The same answer a top-level `function f(a: string): void` with no implementation gets:
    // `function_signature` is not in the statement switch, so nothing is declared by it.
    expect(await idsOf("export class D { f(a: string): void }")).toEqual(["ts:src/a.ts#D"])
  })

  it("leaves a top-level overload pair alone", async () => {
    expect(await idsOf("export function f(a: string): void; export function f(a: any) {}")).toEqual(
      ["ts:src/a.ts#f"],
    )
  })
})

describe("a getter and a setter declare one member", () => {
  const PAIR = "export class Box { get value() { return read() } set value(n) { write(n) } }"

  it("emits one Symbol for the pair", async () => {
    expect(await idsOf(PAIR)).toEqual(["ts:src/a.ts#Box", "ts:src/a.ts#Box.value"])
  })

  it("records that it was declared as an accessor, and that two declarations made it", async () => {
    const symbol = await symbolNamed(PAIR, "ts:src/a.ts#Box.value")
    expect(symbol.derivedBy).toContain("accessor-declaration")
    expect(symbol.derivedBy).toContain("declaration-merged")
  })

  it("takes the signature from the getter", async () => {
    // A property's type is what reading it answers. Taking the setter's signature would
    // report the member as `(n) => void`, which is the type of writing it.
    const symbol = await symbolNamed(PAIR, "ts:src/a.ts#Box.value")
    expect(symbol.signature?.inputs).toEqual([])
  })

  it("walks both bodies", async () => {
    const { calls } = await walkOf(PAIR, "ts:src/a.ts#Box.value")
    expect(calls.map((c) => c.target)).toEqual(["read", "write"])
  })

  it("prefers the getter even when the setter is written first", async () => {
    const source = [
      "export class Box {",
      "  set value(n) { write(n) }",
      "  get value() { return read() }",
      "}",
    ].join("\n")
    const symbol = await symbolNamed(source, "ts:src/a.ts#Box.value")

    expect(symbol.signature?.inputs).toEqual([])
    expect(symbol.source.startLine).toBe(3)
    const { calls } = await walkOf(source, "ts:src/a.ts#Box.value")
    expect(calls.map((c) => c.target)).toEqual(["write", "read"])
  })

  it.each([
    ["a getter alone", "export class G { get v() { return 1 } }"],
    ["a setter alone", "export class G { set v(n) {} }"],
  ])("emits one Symbol for %s, with nothing merged into it", async (_label, source) => {
    const symbol = await symbolNamed(source, "ts:src/a.ts#G.v")
    expect(symbol.derivedBy).toContain("accessor-declaration")
    expect(symbol.derivedBy).not.toContain("declaration-merged")
    expect(symbol.mergedBodyNodes ?? []).toEqual([])
  })

  it("keeps a static pair apart from an instance pair of the same name", async () => {
    const source = [
      "export class S {",
      "  get v() { return 1 }",
      "  set v(n) {}",
      "  static get v() { return 2 }",
      "  static set v(n) {}",
      "}",
    ].join("\n")
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#S", "ts:src/a.ts#S.v", "ts:src/a.ts#S::v"])
  })

  it("keeps a private-name pair private", async () => {
    const source = "export class P { get #v() { return 1 } set #v(n) {} }"
    expect((await symbolNamed(source, "ts:src/a.ts#P.v")).visibility).toBe("private")
  })

  it("does not call a plain method an accessor", async () => {
    const symbol = await symbolNamed("export class A { m() {} }", "ts:src/a.ts#A.m")
    expect(symbol.derivedBy).not.toContain("accessor-declaration")
  })

  it("folds two members that share a name even when neither is an accessor", async () => {
    // `tsc` calls this TS2393; tree-sitter accepts it, and a half-edited file is exactly
    // where a duplicate id used to end the whole run.
    const source = "export class M { m() { a() } m() { b() } }"
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#M", "ts:src/a.ts#M.m"])
    const { calls } = await walkOf(source, "ts:src/a.ts#M.m")
    expect(calls.map((c) => c.target)).toEqual(["a", "b"])
  })

  it("still says nothing about a computed accessor", async () => {
    const source = "export class C { get [k]() { return 1 } set [k](n) {} }"
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C"])
  })

  it("does not call a pair empty-bodied when only the getter is empty", async () => {
    const source = "export class A { get v() {} set v(n) { audit(n) } }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#A.v")
    expect(classifySymbolDropHint(symbol, makeExtractionCtx("src/a.ts", source))).toBeNull()
  })
})

describe("merged declarations are one Symbol", () => {
  it.each([
    [
      "two namespaces",
      "export namespace N { export const a = 1 }\nexport namespace N { export const b = 2 }",
      ["ts:src/a.ts#N", "ts:src/a.ts#N.a", "ts:src/a.ts#N.b"],
    ],
    [
      "three namespaces",
      "export namespace N {}\nexport namespace N {}\nexport namespace N {}",
      ["ts:src/a.ts#N"],
    ],
    [
      "two interfaces",
      "export interface I { a: string }\nexport interface I { b: string }",
      ["ts:src/a.ts#I"],
    ],
    ["two enums", "export enum E { A }\nexport enum E { B }", ["ts:src/a.ts#E"]],
    [
      "a class and a namespace",
      "export class C {}\nexport namespace C { export const a = 1 }",
      ["ts:src/a.ts#C", "ts:src/a.ts#C.a"],
    ],
    [
      "a function and a namespace",
      "export function g() {}\nexport namespace g { export const a = 1 }",
      ["ts:src/a.ts#g", "ts:src/a.ts#g.a"],
    ],
    ["an interface and a class", "export interface P {}\nexport class P {}", ["ts:src/a.ts#P"]],
  ])("emits one Symbol for %s", async (_label, source, ids) => {
    expect(await idsOf(source)).toEqual(ids)
  })

  it("gives the merged Symbol the first declaration's kind and range", async () => {
    // TypeScript requires the class or function to precede the namespace it merges with, so
    // source order already names which declaration carries the value.
    const source = "export class C {}\nexport namespace C { export const a = 1 }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#C")

    expect(symbol.kind).toBe("class")
    expect(symbol.source.startLine).toBe(1)
  })

  it("keeps every declaration's rationale on the Symbol they made", async () => {
    const source = "export class C {}\nexport namespace C { export const a = 1 }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#C")

    expect(symbol.derivedBy).toContain("export-keyword")
    expect(symbol.derivedBy).toContain("namespace-declaration")
    expect(symbol.derivedBy).toContain("declaration-merged")
  })

  it("normalizes both interface bodies into one fingerprint input", async () => {
    const merged = await symbolNamed(
      "export interface I { a: string }\nexport interface I { b: string }",
      "ts:src/a.ts#I",
    )
    const onlyFirst = await symbolNamed("export interface I { a: string }", "ts:src/a.ts#I")

    expect(normalizeAst(merged)).toContain('"b"')
    expect(normalizeAst(merged)).not.toBe(normalizeAst(onlyFirst))
  })

  it("says nothing about merging on a file that merges nothing", async () => {
    const symbols = await symbolsOf("export class A { m() {} }\nexport interface I {}")
    for (const symbol of symbols) {
      expect(symbol.derivedBy).not.toContain("declaration-merged")
      expect(symbol.mergedBodyNodes ?? []).toEqual([])
    }
  })
})

describe("an unexported namespace is a declaration, not an expression", () => {
  // Measured: at statement position tree-sitter parents an unexported `namespace` under
  // `expression_statement` — not only a repeated one, and not only after a `}`. The
  // statement switch never saw it, so every unexported namespace lost its own Symbol and
  // its whole body with it.
  it("extracts a lone unexported namespace and its members", async () => {
    expect(await idsOf("namespace N { export const a = 1 }\n")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.a",
    ])
  })

  it("merges two unexported namespaces and keeps both bodies' members", async () => {
    const source = "namespace N { export const a = 1 }\nnamespace N { export const b = 2 }\n"
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#N", "ts:src/a.ts#N.a", "ts:src/a.ts#N.b"])
  })

  it("merges an unexported namespace into the class it augments", async () => {
    const source = "export class C {}\nnamespace C { export const a = 1 }\n"
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.a"])
  })

  it("leaves the `module` spelling alone, which the grammar never wrapped", async () => {
    expect(await idsOf("module N { export const a = 1 }\n")).toEqual([
      "ts:src/a.ts#N",
      "ts:src/a.ts#N.a",
    ])
  })

  it("does not shadow call extraction on an ordinary expression statement", async () => {
    // The unwrap is why an expression statement is looked at twice, so the reading it was
    // already there for has to survive it: a promoted call is the other thing an expression
    // statement can be.
    const source = "import { app } from './app'\napp.get('/users', () => 1)\n"
    expect(await idsOf(source)).toContain("ts:src/a.ts#app__get__$users__d0")
  })
})
