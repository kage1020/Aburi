import { describe, expect, it } from "vitest"
import { type EnrichmentResult, enrichWithLsp, LSP_TIMEOUT } from "../../src/lsp"
import {
  makeClassSymbol,
  makeEnrichmentInput,
  makeLspConfig,
  makeManualClock,
  makeMethodSymbol,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import { type MockLspClient, mockServerFactory } from "./fixtures/mock-server"

const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"
const HOVER_METHOD = "textDocument/hover"

describe("LSP fallback", () => {
  it("counts per-request timeouts in stats without blocking sibling requests", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [
      { target: "this.foo", line: 4 },
      { target: "this.baz", line: 5 },
    ])
    const baz = makeMethodSymbol("src/a.ts", "C", "baz", 6)
    let call = 0
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => {
        call += 1
        if (call === 1) return LSP_TIMEOUT
        return { contents: "(method) C.baz(): void" }
      })
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar, baz],
        fileContents: {
          "src/a.ts":
            "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.baz()\n  }\n  baz() {}\n}",
        },
        serverFactory: factory,
      }),
    )
    expect(enrichment.stats?.requestsTimedOut).toBeGreaterThanOrEqual(1)
    // At least one hint survived — sibling call unaffected.
    expect(enrichment.receiverHints.size).toBeGreaterThanOrEqual(1)
  })

  it("fires per-file fallback when the fileBudgetMs is exceeded", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [
      { target: "this.foo", line: 4 },
      { target: "this.foo", line: 5 },
      { target: "this.foo", line: 6 },
      { target: "this.foo", line: 7 },
    ])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, async () => {
        await new Promise((r) => setTimeout(r, 80))
        return { contents: "(method) C.foo(): void" }
      })
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: {
          "src/a.ts":
            "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n    this.foo()\n    this.foo()\n  }\n}",
        },
        serverFactory: factory,
        lspConfig: makeLspConfig({
          servers: {
            ts: makeServerConfig({ fileBudgetMs: 100, requestTimeoutMs: 500, concurrency: 1 }),
          },
        }),
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(1)
  })

  it("never silently retries a failed request within the same scan", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    let callCount = 0
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => {
        callCount += 1
        return LSP_TIMEOUT
      })
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
    expect(callCount).toBe(1)
    expect(enrichment.stats?.requestsTimedOut).toBe(1)
    // The unresolved this. call retains no hint.
    expect(enrichment.receiverHints.size).toBe(0)
  })

  it("counts non-timeout failures against requestsFailed, not requestsTimedOut", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, () => ({
        kind: "error" as const,
        reason: "server-error" as const,
        message: "injected",
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
    expect(enrichment.stats?.requestsFailed).toBeGreaterThanOrEqual(1)
    expect(enrichment.stats?.requestsTimedOut).toBe(0)
  })

  it("falls back for the file whose didOpen notification timed out, and only that file", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installDidOpenOutcome((uri) => (uri.endsWith("src/a.ts") ? LSP_TIMEOUT : undefined))
      client.installHandler(DOC_SYMBOL_METHOD, () => [
        {
          name: "foo",
          kind: 6,
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } },
          selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
        },
      ])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: ["src/a.ts", "src/b.ts"].flatMap((file) => [
          makeClassSymbol(file, "C", 1),
          makeMethodSymbol(file, "C", "foo", 2),
        ]),
        fileContents: {
          "src/a.ts": "class C {\n  foo() {}\n}",
          "src/b.ts": "class C {\n  foo() {}\n}",
        },
        serverFactory: factory,
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(1)
    expect(enrichment.stats?.filesEnriched).toBe(1)
    // No request is issued against a file the server never opened…
    expect(requestedUris(captured.client).some((uri) => uri.endsWith("src/a.ts"))).toBe(false)
    // …but it is still closed, and the healthy sibling is enriched normally.
    expect(captured.client?.closedFiles.length).toBe(2)
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, null])
    expect(columnsOf(enrichment, "src/b.ts")).toEqual([null, 3])
  })

  it("fires per-file fallback when didOpen alone consumes the file budget", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const clock = makeManualClock()
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installDidOpenOutcome(() => {
        clock.advance(600)
      })
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), makeMethodSymbol("src/a.ts", "C", "foo", 2)],
        fileContents: { "src/a.ts": "class C {\n  foo() {}\n}" },
        serverFactory: factory,
        // fileBudgetMs is 500 in makeServerConfig — didOpen overspends it by 100.
        now: clock.now,
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(1)
    expect(enrichment.stats?.requestsIssued).toBe(0)
    expect(captured.client?.requests).toEqual([])
  })

  it("keeps a file enriched when only its didClose notification fails", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installDidCloseOutcome(() => LSP_TIMEOUT)
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), makeMethodSymbol("src/a.ts", "C", "foo", 2)],
        fileContents: { "src/a.ts": "class C {\n  foo() {}\n}" },
        serverFactory: factory,
      }),
    )
    expect(enrichment.stats?.filesEnriched).toBe(1)
    expect(enrichment.stats?.filesFellBack).toBe(0)
    // Notification bounds come from the existing knobs, not a new one:
    // didOpen gets the whole file budget, didClose the per-request budget.
    expect(captured.client?.openTimeouts).toEqual([500])
    expect(captured.client?.closeTimeouts).toEqual([100])
  })
})

function requestedUris(client: MockLspClient | null): string[] {
  return (client?.requests ?? []).map((request) => {
    const params = request.params as { textDocument?: { uri?: unknown } }
    const uri = params.textDocument?.uri
    return typeof uri === "string" ? uri : ""
  })
}

function columnsOf(enrichment: EnrichmentResult, file: string): Array<number | null | undefined> {
  return enrichment.symbols
    .filter((symbol) => symbol.source.file === file)
    .map((symbol) => symbol.source.startColumn)
}
