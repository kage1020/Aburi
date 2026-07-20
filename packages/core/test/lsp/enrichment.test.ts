import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../../src/callgraph"
import { enrichWithLsp } from "../../src/lsp"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

describe("LSP enrichment (LE4-LE6, LE16, LE17)", () => {
  it("LE4: this.foo() in class C resolves to C.foo via receiverHints (high)", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        contents: { kind: "markdown", value: "(method) C.foo(): void" },
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}",
        },
        serverFactory: factory,
      }),
    )
    const hint = enrichment.receiverHints.get("src/a.ts:4")
    expect(hint).toBeDefined()
    expect(hint?.kind).toBe("this")
    expect(hint?.ownerClassId).toBe("ts:src/a.ts#C.foo")
    expect(hint?.walkedHierarchy).toBe(false)

    // Feed into resolver — must produce a high-confidence edge.
    const result = resolveCallGraph({
      symbols: enrichment.symbols,
      importsByFile: new Map(),
      receiverHints: enrichment.receiverHints,
      implementerHints: enrichment.implementerHints,
    })
    const edge = result.edges.find((e) => e.from === "ts:src/a.ts#C.bar")
    expect(edge).toBeDefined()
    expect(edge?.to).toBe("ts:src/a.ts#C.foo")
    expect(edge?.confidence).toBe("high")
  })

  it("LE6: file with no this./super./interface receivers → columns-only pass", async () => {
    const helper = makeMethodSymbol("src/a.ts", "M", "helper", 3)
    // The mock returns nothing — no receiverHints should appear either.
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [
        {
          name: "helper",
          kind: 12,
          range: {
            start: { line: 2, character: 2 },
            end: { line: 2, character: 20 },
          },
          selectionRange: {
            start: { line: 2, character: 2 },
            end: { line: 2, character: 8 },
          },
        },
      ])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [helper],
        fileContents: { "src/a.ts": "\n\n  helper() {\n  }" },
        serverFactory: factory,
      }),
    )
    expect(enrichment.receiverHints.size).toBe(0)
    expect(enrichment.symbols[0]?.source.startColumn).toBe(3)
  })

  it("LE17: inferredThrows is OMITTED (not empty) when hover returns no @throws", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        contents: { kind: "markdown", value: "(method) C.foo(): void" },
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}",
        },
        serverFactory: factory,
      }),
    )
    const barSymbol = enrichment.symbols.find((s) => s.id === "ts:src/a.ts#C.bar") as IRSymbol
    const sig = barSymbol.signature
    expect(sig).not.toBeNull()
    expect(sig).toBeDefined()
    if (sig !== null && sig !== undefined) {
      expect(Object.hasOwn(sig, "inferredThrows")).toBe(false)
    }
  })

  it("LE17 companion: inferredThrows appears when hover carries @throws", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        contents: {
          kind: "markdown",
          value: "(method) C.foo(): void\n@throws {NetworkError} on offline",
        },
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}",
        },
        serverFactory: factory,
      }),
    )
    const barSymbol = enrichment.symbols.find((s) => s.id === "ts:src/a.ts#C.bar") as IRSymbol
    expect(barSymbol.signature?.inferredThrows).toEqual(["NetworkError"])
    // The explicit `throws[]` MUST NOT change (LE12 for parity).
    expect(barSymbol.signature?.throws).toEqual([])
  })

  it("LE16: LSP-on confidence for LSP-resolved calls is always >= untyped-tier (which was null for this./super.)", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    // LSP-off run: this.foo stays unresolved (no edge).
    const off = resolveCallGraph({ symbols: [cls, foo, bar], importsByFile: new Map() })
    expect(off.edges).toHaveLength(0)

    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        contents: "(method) C.foo(): void",
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}",
        },
        serverFactory: factory,
      }),
    )
    const on = resolveCallGraph({
      symbols: enrichment.symbols,
      importsByFile: new Map(),
      receiverHints: enrichment.receiverHints,
      implementerHints: enrichment.implementerHints,
    })
    expect(on.edges).toHaveLength(1)
    expect(on.edges[0]?.confidence).toBe("high")
  })
})
