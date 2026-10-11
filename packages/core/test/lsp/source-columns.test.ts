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
})
