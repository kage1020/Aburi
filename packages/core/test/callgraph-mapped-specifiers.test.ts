import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../src/callgraph"
import { type ImportClause, importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const CALLER = "ts:apps/api/main.ts#main"

function resolveThrough(
  edge: ImportClause,
  target: string,
  symbols: readonly IRSymbol[],
  paths: readonly string[] = ["libs/billing/src/index.ts"],
) {
  return resolveCallGraph({
    symbols: [withCalls(CALLER, [{ target, line: 2 }]), ...symbols],
    importsByFile: importsOf("apps/api/main.ts", edge),
    specifierPaths: new Map([["apps/api/main.ts", new Map([[edge.source, paths]])]]),
  })
}

const formatInvoice = makeSymbol("ts:libs/billing/src/index.ts#formatInvoice")

describe("import scope — a bare specifier the language maps to workspace paths", () => {
  it.each<[string, ImportClause, string, readonly string[]]>([
    [
      "a named import",
      { source: "@app/billing", symbols: ["formatInvoice"] },
      "formatInvoice",
      ["libs/billing/src/index.ts"],
    ],
    [
      "an aliased import, by its exported name",
      { source: "@app/billing", symbols: ["formatInvoice as format"] },
      "format",
      ["libs/billing/src/index.ts"],
    ],
    [
      "a namespace import",
      { source: "@app/billing", symbols: "*", namespaceBinding: "billing" },
      "billing.formatInvoice",
      ["libs/billing/src/index.ts"],
    ],
    [
      "a path that names a directory, probed as a relative specifier's path is",
      { source: "@app/billing", symbols: ["formatInvoice"] },
      "formatInvoice",
      ["libs/billing/src"],
    ],
    [
      "the first path that is a file, past one that is not",
      { source: "@app/billing", symbols: ["formatInvoice"] },
      "formatInvoice",
      ["libs/missing/src", "libs/billing/src/index"],
    ],
  ])("resolves %s to the Symbol, at high confidence", (_case, edge, target, paths) => {
    const result = resolveThrough(edge, target, [formatInvoice], paths)
    expect(result.edges.map((e) => [e.to, e.confidence])).toEqual([
      ["ts:libs/billing/src/index.ts#formatInvoice", "high"],
    ])
    expect(result.diagnostics).toEqual([])
  })

  it("buckets a name the mapped file does not declare `no-match`, not `external`", () => {
    const result = resolveThrough(
      { source: "@app/billing", symbols: ["B as missing"] },
      "missing",
      [formatInvoice],
    )
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["no-match"])
  })

  it("leaves a specifier mapped to no file with Symbols a bare one: `external`, then steps 4–5", () => {
    const elsewhere = makeSymbol("ts:packages/pkg/src/util.ts#Logger.log")
    const unmapped = ["packages/pkg/src/missing"]
    const named = resolveThrough(
      { source: "@app/pkg", symbols: ["Logger"] },
      "Logger.log",
      [elsewhere],
      unmapped,
    )
    expect(named.edges.map((e) => e.to)).toEqual(["ts:packages/pkg/src/util.ts#Logger.log"])

    const aliased = resolveThrough(
      { source: "@app/pkg", symbols: ["Logger as L"] },
      "L.log",
      [elsewhere],
      unmapped,
    )
    expect(aliased.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })

  it("reads the paths of the caller's own file only", () => {
    const result = resolveCallGraph({
      symbols: [withCalls(CALLER, [{ target: "f", line: 2 }]), formatInvoice],
      importsByFile: importsOf("apps/api/main.ts", {
        source: "@app/billing",
        symbols: ["formatInvoice as f"],
      }),
      specifierPaths: new Map([
        ["apps/web/main.ts", new Map([["@app/billing", ["libs/billing/src/index.ts"]]])],
      ]),
    })
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["external"])
  })
})
