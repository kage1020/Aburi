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

const TWO_DOTTED = ["export namespace A.B {}", "export namespace A.C {}"].join("\n")

const TWO_ENUMS = ["export enum E { A }", "export enum E { B }"].join("\n")

const CLASS_AND_NAMESPACE_MEMBER = [
  "export class C {",
  "  m(a: string) { inner(a) }",
  "}",
  "export namespace C {",
  "  export function m(b: number) { other(b) }",
  "}",
].join("\n")

const NESTED_NAMESPACE = [
  "export namespace Outer {",
  "  namespace Inner { export const a = 1 }",
  "}",
].join("\n")

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
    expect("mergedDeclarations" in symbol).toBe(false)
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

  it("keeps a decorator written on the declaration that did not lead", async () => {
    const source = [
      "export class A {",
      "  @Memo() get v() { return 1 }",
      "  @Validate() set v(n) {}",
      "}",
    ].join("\n")
    const symbol = await symbolNamed(source, "ts:src/a.ts#A.v")

    expect(symbol.decorators.map((d) => d.name)).toEqual(["Memo", "Validate"])
  })

  it("folds a private-name member into the public one of the same name", async () => {
    // `v` and `#v` are two members and `tsc` accepts both, but `#` is not a qualified-name
    // segment character, so the id builder is handed `Q.v` for each. The convention predates
    // this change; what changed is the consequence — a duplicate id used to end the run, and
    // now the two fold. The IR says one member where the source has two.
    const source = "export class Q { v() { a() } #v() { b() } }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#Q.v")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#Q", "ts:src/a.ts#Q.v"])
    expect(symbol.derivedBy).toContain("declaration-merged")
    expect((await walkOf(source, "ts:src/a.ts#Q.v")).calls.map((c) => c.target)).toEqual(["a", "b"])
    expect(symbol.visibility).toBe("public")
  })

  it("reports the private one when the private one is written first", async () => {
    // The scalars come from the leading declaration, so reordering the two members changes
    // what the folded Symbol says it is: the public method is the one that disappears, and
    // the survivor reports itself private. That is a property of the fold being wrong here
    // rather than of the rule, so it is pinned where the fold is instead of smoothed over.
    const source = "export class Q { #v(a: number) {} v(c: string) {} }"
    const symbol = await symbolNamed(source, "ts:src/a.ts#Q.v")

    expect(symbol.visibility).toBe("private")
    expect(symbol.signature?.inputs).toEqual([{ name: "a", type: "number" }])
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

  it("keeps the boundary evidence of a class an interface was declared before", async () => {
    // The one merge whose declarations can disagree about something that matters: an
    // interface may be written before the class it merges with, and a decorator kept only
    // from the leading declaration would be gone. `decideSymbolDrop` reads boundary
    // decorators before it drops anything of kind `interface`, so losing one is the
    // difference between a controller in the IR and a Symbol dropped as a data model.
    const source = ["export interface P {}", "@Controller()", "export class P {}"].join("\n")
    const symbol = await symbolNamed(source, "ts:src/a.ts#P")

    expect(symbol.kind).toBe("interface")
    expect(symbol.decorators.map((d) => d.name)).toEqual(["Controller"])
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

  it("puts a reopened enum's members into the fingerprint input", async () => {
    // An enum candidate has no `bodyNode` — its members are not Symbols — so a merged
    // declaration reaches the fingerprint only through its `fullNode`. Carrying bodies alone
    // made adding, editing or deleting the second `enum E {}` change nothing at all.
    const one = await symbolNamed("export enum E { A }", "ts:src/a.ts#E")
    const two = await symbolNamed(TWO_ENUMS, "ts:src/a.ts#E")
    const other = await symbolNamed(TWO_ENUMS.replace("B", "ZZZ"), "ts:src/a.ts#E")

    expect(normalizeAst(two)).not.toBe(normalizeAst(one))
    expect(normalizeAst(two)).not.toBe(normalizeAst(other))
  })

  it("folds an instance member into a namespace export of the same name", async () => {
    // `C.prototype.m` and `C.m` are two entities, and the qname convention spells both
    // `#C.m` — only `static` gets `::`. The fold is what a duplicate id used to end the run
    // over; it is still one Symbol where the source has two, which is why the calls it
    // reports reach past its own range.
    const symbol = await symbolNamed(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C.m")

    expect(await idsOf(CLASS_AND_NAMESPACE_MEMBER)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.m"])
    expect(symbol.kind).toBe("method")
    expect(symbol.source.startLine).toBe(2)
    expect(
      (await walkOf(CLASS_AND_NAMESPACE_MEMBER, "ts:src/a.ts#C.m")).calls.map((c) => c.line),
    ).toEqual([2, 5])
  })

  it("says nothing about merging on a file that merges nothing", async () => {
    const symbols = await symbolsOf("export class A { m() {} }\nexport interface I {}")
    for (const symbol of symbols) {
      expect(symbol.derivedBy).not.toContain("declaration-merged")
      expect("mergedDeclarations" in symbol).toBe(false)
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

  it("reads a namespace nested inside another one", async () => {
    // Load-bearing ordering: the unwrap runs before the guard that stops a namespace-scoped
    // expression statement from being read as a call, so an inner namespace is reached.
    expect(await idsOf(NESTED_NAMESPACE)).toEqual([
      "ts:src/a.ts#Outer",
      "ts:src/a.ts#Outer.Inner",
      "ts:src/a.ts#Outer.Inner.a",
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

describe("a dotted namespace declares each of its segments", () => {
  // `namespace A.B {}` is sugar for `namespace A { namespace B {} }`, and reading the dotted
  // text as one qualified-name segment is what the id builder refuses. Two of the three
  // spellings threw before this change and cost the file every Symbol it had; the unexported
  // one produced nothing at all, which is how it went unnoticed for so long.
  it.each([
    ["unexported", "namespace A.B { export const x = 1 }"],
    ["exported", "export namespace A.B { export const x = 1 }"],
    ["the module spelling", "module A.B { export const x = 1 }"],
  ])("declares the head, the tail and the body — %s", async (_label, source) => {
    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.B", "ts:src/a.ts#A.B.x"])
  })

  it("declares three segments for a three-part name", async () => {
    expect(await idsOf("export namespace My.App.Utils {}")).toEqual([
      "ts:src/a.ts#My",
      "ts:src/a.ts#My.App",
      "ts:src/a.ts#My.App.Utils",
    ])
  })

  it("gives two dotted declarations under one head a single head Symbol", async () => {
    const source = TWO_DOTTED
    const head = await symbolNamed(source, "ts:src/a.ts#A")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.B", "ts:src/a.ts#A.C"])
    expect(head.derivedBy).toContain("declaration-merged")
  })
})
