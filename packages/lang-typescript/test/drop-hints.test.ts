import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifySymbolDropHint, TYPESCRIPT_FILE_DROP_PATTERNS } from "../src/index"
import { makeTsSymbolId } from "../src/qname"
import { hintOf, makeExtractionCtx } from "./fixtures/ctx"

const CONSTANTS_PLUS_INTERFACE = [
  "export class P { static readonly A = 1 }",
  "export interface P { b: string }",
].join("\n")

const DTO_PLUS_INTERFACE = [
  "export class D { a: string = '' }",
  "export interface D { m(): void }",
].join("\n")

/** A candidate with nothing on it, so a test can vary one field and read the arm it hits. */
const BARE_SYMBOL: SymbolCandidate<Node> = {
  id: makeTsSymbolId("src/a.ts", "X"),
  kind: "class",
  extKind: null,
  name: "X",
  visibility: "public",
  decorators: [],
  signature: null,
  source: { file: "src/a.ts", startLine: 1, endLine: 1, startColumn: null, endColumn: null },
  derivedBy: [],
  bodyNode: null,
  fullNode: {} as Node,
}

describe("classifySymbolDropHint", () => {
  it("marks an interface as Category B with 'interface (data model)'", async () => {
    expect(
      await hintOf("export interface Invoice { total: number }", "ts:src/a.ts#Invoice"),
    ).toEqual({ reason: "interface (data model)", category: "B" })
  })

  it("marks a type alias as Category B with 'type alias'", async () => {
    expect(await hintOf("export type Amount = number", "ts:src/a.ts#Amount")).toEqual({
      reason: "type alias",
      category: "B",
    })
  })

  it("marks a class with only field declarations as pure DTO", async () => {
    expect(
      await hintOf("export class Invoice { total: number = 0 }", "ts:src/a.ts#Invoice"),
    ).toEqual({ reason: "pure DTO", category: "B" })
  })

  it("marks a class with only static readonly literal fields as pure constants", async () => {
    expect(
      await hintOf(
        "export class Constants { static readonly PI = 3.14; static readonly E = 2.72 }",
        "ts:src/a.ts#Constants",
      ),
    ).toEqual({ reason: "pure constants", category: "B" })
  })

  it("does not mark a class with a method as pure DTO", async () => {
    expect(
      await hintOf(
        "export class InvoiceService { create() { return 1 } }",
        "ts:src/a.ts#InvoiceService",
      ),
    ).toBeNull()
  })

  it("marks an empty function as Category B with 'empty body'", async () => {
    expect(await hintOf("export function noop() {}", "ts:src/a.ts#noop")).toEqual({
      reason: "empty body",
      category: "B",
    })
  })

  it("keeps a Symbol carrying a boundary decorator, whatever its kind", () => {
    // `decideDropReason` in core asks `decideSymbolDrop` first, which answers `null` on a
    // boundary decorator, and then asks this. So an arm here that never looks at decorators
    // is the one that decides — `drop-list.md` puts a boundary outside Category B, and
    // that has to hold for every kind, not only for the class arm that already checked.
    const boundary = [
      { name: "Controller", raw: "@Controller()", arguments: [], boundary: true, line: 1 },
    ]
    for (const kind of ["interface", "type", "class", "method", "function"] as const) {
      const symbol = {
        ...BARE_SYMBOL,
        kind,
        decorators: boundary,
      }
      expect(classifySymbolDropHint(symbol, makeExtractionCtx("src/a.ts", ""))).toBeNull()
    }
  })

  it("reads only class bodies when a class is merged with an interface", async () => {
    // A merged `interface C {}` contributes its `interface_body`, whose `property_signature`
    // and `method_signature` members would read as the class's own — turning `pure constants`
    // into `pure DTO`, and a DTO into a Symbol that is not dropped at all.
    expect(await hintOf(CONSTANTS_PLUS_INTERFACE, "ts:src/a.ts#P")).toEqual({
      reason: "pure constants",
      category: "B",
    })
    expect(await hintOf(DTO_PLUS_INTERFACE, "ts:src/a.ts#D")).toEqual({
      reason: "pure DTO",
      category: "B",
    })
  })
})

/**
 * The Category-A half of this module, which is a list rather than a function and so has no
 * behaviour a hint test reaches. Nothing else in the workspace reads it: the plugin copies it
 * into `fileDropPatterns` and core applies it to paths, so an entry dropped from here makes
 * every declaration file scannable — every ambient interface in a dependency's `.d.ts` landing
 * in the IR as a data model — with every other suite still green.
 */
describe("the file drop patterns this plugin adds to the core standard set", () => {
  it("names a declaration file in each of the three module spellings", () => {
    expect([...TYPESCRIPT_FILE_DROP_PATTERNS].sort()).toEqual([
      "**/*.d.cts",
      "**/*.d.mts",
      "**/*.d.ts",
    ])
  })
})
