import { describe, expect, it } from "vitest"
import { extractSymbols, langTypescriptManifest, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * Three legal shapes fed something that is not a name into the Symbol-id builder, which
 * throws — and the throw costs the whole file, not the one declaration. A `class A` with a
 * computed member lost `A` and every other method with it.
 *
 * A destructuring declaration declares its *bindings*, so that is what comes out of it. A
 * computed member name is not a name static analysis can record, so nothing comes out of that
 * — the same position `lang-plugin.md` LP26e takes on a computed module specifier, and for
 * the same reason: it is not a fault in the source.
 */

async function symbolsOf(source: string) {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source))
}

async function symbolIdsOf(source: string): Promise<string[]> {
  return (await symbolsOf(source)).map((s) => s.id)
}

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
    expect(await symbolIdsOf(source)).toEqual(names.map((n) => `ts:src/a.ts#${n}`))
  })

  it("reads the value side of a rename, not the key being read from", async () => {
    // `{ a: b }` binds `b`. `a` is a property name on the right-hand side's type — nothing is
    // declared under it, and a Symbol called `a` would be a name this file does not define.
    expect(await symbolIdsOf("export const { a: b } = m")).toEqual(["ts:src/a.ts#b"])
  })

  it.each([
    ["a shorthand default", "export const { a = fallback } = m"],
    ["an array default", "export const [a = fallback] = pair"],
    ["a renamed default", "export const { z: a = fallback } = m"],
  ])("does not mistake %s's expression for a binding", async (_label, source) => {
    // These bind `a` and *read* `fallback`. Walking the whole pattern for identifiers would
    // declare a Symbol for a name that lives in another file. Three forms because the
    // grammar has two node types for a default — `object_assignment_pattern` for the object
    // shorthand and `assignment_pattern` everywhere else — and covering only the first is
    // how the array and renamed forms came to bind nothing at all.
    expect(await symbolIdsOf(source)).toEqual(["ts:src/a.ts#a"])
  })

  it.each([
    ["a renamed member expression", "export const { a: obj.b } = m"],
    ["an array element", "export const [obj.a] = pair"],
    ["a rest element", "export const [...obj.a] = pair"],
  ])("refuses a pattern it cannot read, rather than binding nothing — %s", async (_l, source) => {
    // A `member_expression` is a legal destructuring *assignment* target, and the grammar
    // shares the node with a declaration's pattern — `tsc` says TS1005 here, tree-sitter
    // says nothing. Passing over it would drop the declaration with no Symbol and no word,
    // which is the failure this whole change is about; refusing sends the file to the
    // per-file boundary, which names it.
    await expect(symbolIdsOf(source)).rejects.toThrow(/Unmodelled node "member_expression"/)
  })

  it.each([
    ["an object pattern", "export const { a, /* c */ b } = m"],
    ["an array pattern", "export const [a, /* c */ b] = pair"],
  ])("reads past a comment written inside %s", async (_label, source) => {
    // A comment is a named child of both pattern kinds, and the walk refuses a node type it
    // does not model rather than passing over it — so this is the case that keeps the
    // refusal from firing on ordinary source.
    expect(await symbolIdsOf(source)).toEqual(["ts:src/a.ts#a", "ts:src/a.ts#b"])
  })

  it("gives every binding the kind and range a plain const gets", async () => {
    const symbols = await symbolsOf("export const { GET, POST } = handlers")

    expect(symbols.map((s) => s.kind)).toEqual(["const", "const"])
    expect(symbols.map((s) => s.visibility)).toEqual(["public", "public"])
    // One declaration, so one range: the `derivedBy` token is what tells a reader why two
    // Symbols point at the same lines.
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
    // Pairing `{ GET }` with the `GET:` property of the initializer is analysis this plugin
    // does not do for anything else. Claiming `function` here would make the two paths
    // disagree about what evidence a kind needs.
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
    expect(await symbolIdsOf("export namespace N { export const { a, b } = m }")).toEqual([
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
    ["export interface I {}", ["interface-declaration"]],
    ["export type T = 1", ["type-alias"]],
    ["export enum E { A }", ["enum-declaration"]],
    ["export namespace N {}", ["namespace-declaration"]],
    ["export default function () {}", ["export-default"]],
  ])("declares the rationales %s produces", async (source, expected) => {
    // `fp-extension-impl.md` FP-A3 wants at least one entry per Symbol to identify the
    // emitting plugin under a prefix it owns, and `findDerivedByOwner` resolves it from this
    // list. Nothing enforces it at load time — the manifest comment used to claim otherwise —
    // so this is where the list is held to what extraction actually emits. A token missing
    // here is a Symbol no plugin owns.
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
    const ids = await symbolIdsOf("export class A { [Symbol.iterator]() {} m() {} }")

    // Before, the whole file was lost — `A` and `m` with it — because the id builder was
    // handed `[Symbol.iterator]` and refused it.
    expect(ids).toEqual(["ts:src/a.ts#A", "ts:src/a.ts#A.m"])
  })

  it.each([
    ["a well-known symbol", "export class A { [Symbol.iterator]() {} }"],
    ["a string literal", 'export class A { ["go"]() {} }'],
    ["an expression", "export class A { [key + 1]() {} }"],
    ["a static computed member", "export class A { static [Symbol.iterator]() {} }"],
  ])("produces nothing for %s, and says nothing", async (_label, source) => {
    // Normalising the brackets into a segment is refused rather than deferred: any mangling
    // invents a name the source does not contain, two different computed keys can collapse
    // onto one segment, and nothing can read it back to what was written.
    const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
    const ids = extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source)).map(
      (s) => s.id,
    )

    expect(ids).toEqual(["ts:src/a.ts#A"])
    expect(result.errors).toEqual([])
  })
})

describe("an identifier the grammar refused is a Symbol now", () => {
  it.each([
    ["a Japanese function", "export function ユーザー取得() {}", "ユーザー取得"],
    ["an accented function", "export function café() {}", "café"],
    ["a Japanese class", "export class クラス {}", "クラス"],
  ])("extracts %s", async (_label, source, name) => {
    expect(await symbolIdsOf(source)).toEqual([`ts:src/a.ts#${name}`])
  })

  it("keeps a whole file that mixes one with ordinary declarations", async () => {
    const ids = await symbolIdsOf("export function ユーザー取得() {}\nexport function ok() {}")

    // Sorted by id, which is how `extractSymbols` returns them — not source order.
    expect(ids).toEqual(["ts:src/a.ts#ok", "ts:src/a.ts#ユーザー取得"])
  })
})
