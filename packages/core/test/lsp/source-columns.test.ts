import { symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol"
import { makeSymbol } from "../fixtures/ir"
import { enrich, makeClassSymbol, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { docSymbol, documentSymbolServer } from "./fixtures/mock-server"

/** A chain `depth` entries long, each one the only child of the one above it. */
function nested(depth: number, leafName: string, leafLine: number): DocumentSymbol {
  let entry = docSymbol(leafName, leafLine, 6)
  for (let i = 0; i < depth; i++) entry = docSymbol(`filler${i}`, 900 + i, 0, [entry])
  return entry
}

const FLAT_ENTRY: SymbolInformation = {
  name: "C",
  kind: 5,
  location: {
    uri: "file:///workspace/src/a.ts",
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
  },
}

async function columnsFor(symbols: IRSymbol[], content: string, entries: unknown[]) {
  const result = await enrich({
    symbols,
    fileContents: { "src/a.ts": content },
    serverFactory: documentSymbolServer(() => entries),
  })
  return Object.fromEntries(
    result.symbols.map((s) => [s.id, [s.source.startColumn, s.source.endColumn]]),
  )
}

const anonymousDefault: IRSymbol = {
  ...makeClassSymbol("src/a.ts", "<default>", 1),
  kind: "function",
}

describe("source columns from documentSymbol", () => {
  it("writes the entry sharing a Symbol's line and last name segment as 1-based columns", async () => {
    const result = await enrich({
      symbols: [makeMethodSymbol("src/a.ts", "M", "helper", 3)],
      fileContents: { "src/a.ts": "\n\n  helper() {\n  }" },
      serverFactory: documentSymbolServer(() => [docSymbol("helper", 3, 2)]),
    })

    expect(result.symbols[0]?.source).toMatchObject({ startColumn: 3, endColumn: 9 })
  })

  it("matches a static member by the segment after its `::`", async () => {
    const result = await enrich({
      symbols: [
        makeSymbol("ts:src/a.ts#M::helper", {
          kind: "method",
          source: {
            file: "src/a.ts",
            startLine: 3,
            endLine: 3,
            startColumn: null,
            endColumn: null,
          },
        }),
      ],
      fileContents: { "src/a.ts": "\n\n  static helper() {\n  }" },
      serverFactory: documentSymbolServer(() => [docSymbol("helper", 3, 9)]),
    })

    expect(result.symbols[0]?.source.startColumn).toBe(10)
  })

  it("leaves the columns null when no entry shares both the line and the name", async () => {
    const result = await enrich({
      symbols: [makeMethodSymbol("src/a.ts", "M", "helper", 3)],
      fileContents: { "src/a.ts": "\n\n  helper() {}\n  other() {}" },
      serverFactory: documentSymbolServer(() => [
        docSymbol("helper", 4, 2),
        docSymbol("other", 3, 2),
      ]),
    })

    expect(result.symbols[0]?.source).toMatchObject({ startColumn: null, endColumn: null })
  })

  it.each<[string, () => unknown[]]>([
    ["an entry nested deeper than the call stack would allow", () => [nested(50_000, "C", 1)]],
    [
      "the outer of two matches, since a parent comes before its children",
      () => [docSymbol("C", 1, 6, [docSymbol("C", 1, 20)]), docSymbol("D", 2, 30)],
    ],
    [
      "the first of two children on one line",
      () => [docSymbol("wrapper", 5, 0, [docSymbol("C", 1, 6), docSymbol("C", 1, 40)])],
    ],
    [
      "the first of two top-level entries on one line",
      () => [docSymbol("C", 1, 6), docSymbol("C", 1, 40)],
    ],
    ["an entry whose child list is null", () => [{ ...docSymbol("C", 1, 6), children: null }]],
    ["a flat SymbolInformation answer", () => [FLAT_ENTRY]],
  ])("takes the column from %s", async (_, entries) => {
    const result = await enrich({
      symbols: [makeClassSymbol("src/a.ts", "C", 1)],
      fileContents: { "src/a.ts": "class C {}\n" },
      serverFactory: documentSymbolServer(entries),
    })

    expect(result.symbols[0]?.source.startColumn).toBe(7)
  })

  it.each<[string, string, IRSymbol, DocumentSymbol, [number, number] | [null, null]]>([
    [
      "an exported class under a decorator on the line above at its first modifier",
      "@Dec()\n\t  export class D {}\n",
      makeClassSymbol("src/a.ts", "D", 2),
      docSymbol("D", 1, 0, [], { line: 2, startCol: 16 }),
      [4, 18],
    ],
    [
      "a class after a decorator on its line at its keyword",
      "  @Dec() class D {}\n",
      makeClassSymbol("src/a.ts", "D", 1),
      docSymbol("D", 1, 2, [], { line: 1, startCol: 15 }),
      [10, 17],
    ],
    [
      "a method under two decorators over two lines at its name",
      "  @A()\n  @B() m() {}\n",
      makeMethodSymbol("src/a.ts", "K", "m", 2),
      docSymbol("m", 1, 2, [], { line: 2, startCol: 7 }),
      [8, 9],
    ],
    [
      "a method whose decorator closes on its line at its name",
      '  @Get({\n    path: "a",\n  }) list(): number {}\n',
      makeMethodSymbol("src/a.ts", "K", "list", 3),
      docSymbol("list", 1, 2, [], { line: 3, startCol: 5 }),
      [6, 10],
    ],
    [
      "an exported class whose decorator closes on its line at its first modifier",
      "@Svc({\n}) export class Svc {}\n",
      makeClassSymbol("src/a.ts", "Svc", 2),
      docSymbol("Svc", 1, 0, [], { line: 2, startCol: 16 }),
      [4, 20],
    ],
    [
      "a method under a decorator named like a modifier at its name",
      "  @readonly m() {}\n",
      makeMethodSymbol("src/a.ts", "K", "m", 1),
      docSymbol("m", 1, 2, [], { line: 1, startCol: 12 }),
      [13, 14],
    ],
    [
      "a member at the first of its modifiers",
      "  @Dec() static async *gen() {}\n",
      makeMethodSymbol("src/a.ts", "K", "gen", 1),
      docSymbol("gen", 1, 2, [], { line: 1, startCol: 23 }),
      [10, 27],
    ],
    [
      "a class whose IR line is its decorator's own at the decorator",
      "@Dec()\nclass D {}\n",
      makeClassSymbol("src/a.ts", "D", 1),
      docSymbol("D", 1, 0, [], { line: 2, startCol: 6 }),
      [1, 8],
    ],
    [
      "a class whose IR line holds only a decorator at no column",
      "@A()\n@B()\nclass D {}\n",
      makeClassSymbol("src/a.ts", "D", 2),
      docSymbol("D", 1, 0, [], { line: 3, startCol: 6 }),
      [null, null],
    ],
  ])("starts %s", async (_, content, symbol, entry, expected) => {
    expect(await columnsFor([symbol], content, [entry])).toEqual({ [symbol.id]: expected })
  })

  it("takes an entry starting on the Symbol's line before one whose decorators start above it", async () => {
    const entries = [docSymbol("Foo", 1, 0, [docSymbol("Foo", 2, 12)], { line: 2, startCol: 6 })]

    expect(
      await columnsFor(
        [makeClassSymbol("src/a.ts", "Foo", 1), makeMethodSymbol("src/a.ts", "Foo", "Foo", 2)],
        "@Dec()\nclass Foo { Foo(): void {}\n}\n",
        entries,
      ),
    ).toEqual({ "ts:src/a.ts#Foo": [1, 10], "ts:src/a.ts#Foo.Foo": [13, 16] })
  })

  it("matches nothing on a line outside the span from the range's start to the name", async () => {
    const at = (line: number, id: string): IRSymbol => ({
      ...makeClassSymbol("src/a.ts", "D", line),
      id: symbolId(id),
    })

    expect(
      await columnsFor(
        [at(1, "ts:src/a.ts#D"), at(4, "ts:src/a.ts#D2"), at(3, "ts:src/a.ts#D3")],
        "\n@Dec\nclass D {\n}\n",
        [docSymbol("D", 2, 0, [], { line: 3, startCol: 6 })],
      ),
    ).toEqual({
      "ts:src/a.ts#D": [null, null],
      "ts:src/a.ts#D2": [null, null],
      "ts:src/a.ts#D3": [1, 8],
    })
  })

  it("names a top-level `default` entry <default>, but not a member called default", async () => {
    const member = makeMethodSymbol("src/a.ts", "K", "default", 3)
    const memberNamedDefault = { ...makeMethodSymbol("src/a.ts", "K", "x", 4), name: "K.<default>" }
    const entries = [
      docSymbol("default", 1, 0),
      docSymbol("K", 2, 0, [docSymbol("default", 3, 2), docSymbol("default", 4, 2)], {
        line: 2,
        startCol: 6,
      }),
    ]
    const content = "export default function () {}\nclass K {\n  default() {}\n  default() {}\n}\n"

    expect(
      await columnsFor([anonymousDefault, member, memberNamedDefault], content, entries),
    ).toEqual({
      "ts:src/a.ts#<default>": [1, 8],
      "ts:src/a.ts#K.default": [3, 10],
      "ts:src/a.ts#K.x": [null, null],
    })
  })

  it.each<[string, Partial<SymbolInformation>, [number, number] | [null, null]]>([
    ["with no container as the default export", {}, [1, 31]],
    ["inside a container as a member", { containerName: "K" }, [null, null]],
  ])("reads a flat `default` entry %s", async (_, container, expected) => {
    const entry: SymbolInformation = {
      name: "default",
      kind: 12,
      location: {
        uri: "file:///workspace/src/a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 30 } },
      },
      ...container,
    }

    expect(
      await columnsFor([anonymousDefault], "export default function () {}\n", [entry]),
    ).toEqual({ "ts:src/a.ts#<default>": expected })
  })
})
