import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../../src/callgraph"
import { enrichWithLsp } from "../../src/lsp"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

describe("LSP enrichment", () => {
  it("resolves this.foo() in class C to C.foo via receiverHints at high confidence", async () => {
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
    expect(hint?.targetSymbolId).toBe("ts:src/a.ts#C.foo")

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

  it("resolves super.foo() using the receiver type reported by hover", async () => {
    const base = makeClassSymbol("src/a.ts", "Base", 1)
    const baseFoo = makeMethodSymbol("src/a.ts", "Base", "foo", 2)
    const sub = makeClassSymbol("src/a.ts", "Sub", 4)
    const subFoo = makeMethodSymbol("src/a.ts", "Sub", "foo", 5, [{ target: "super.foo", line: 6 }])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        contents: { kind: "markdown", value: "(method) Base.foo(): void" },
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [base, baseFoo, sub, subFoo],
        fileContents: {
          "src/a.ts":
            "class Base {\n  foo() {}\n}\nclass Sub extends Base {\n  foo() {\n    super.foo()\n  }\n}",
        },
        serverFactory: factory,
      }),
    )
    const hint = enrichment.receiverHints.get("src/a.ts:6")
    expect(hint?.kind).toBe("super")
    expect(hint?.targetSymbolId).toBe("ts:src/a.ts#Base.foo")
  })

  it("only touches SourceRange columns when the file has no this./super. call sites", async () => {
    const helper = makeMethodSymbol("src/a.ts", "M", "helper", 3)
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

  it("omits Signature.inferredThrows entirely when hover carries no @throws", async () => {
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
    expect(sig).toBeDefined()
    if (sig !== null && sig !== undefined) {
      expect(Object.hasOwn(sig, "inferredThrows")).toBe(false)
    }
  })

  it("collects inferredThrows from JSDoc @throws in hover text without touching Signature.throws", async () => {
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
    expect(barSymbol.signature?.throws).toEqual([])
  })

  it("never lowers edge confidence relative to the untyped tier", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
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
