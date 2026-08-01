import { describe, expect, it, vi } from "vitest"
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
      client.installDidOpenOutcome((uri) => (uri.endsWith("src/a.ts") ? LSP_TIMEOUT : null))
      client.installHandler(DOC_SYMBOL_METHOD, () => [FOO_DOC_SYMBOL])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: ["src/a.ts", "src/b.ts"].flatMap(classWithMethod),
        fileContents: {
          "src/a.ts": FILE_SOURCE,
          "src/b.ts": FILE_SOURCE,
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
    // A notification is not a request: a failed one moves no request counter.
    expect(enrichment.stats?.requestsTimedOut).toBe(0)
    expect(enrichment.stats?.requestsFailed).toBe(0)
    expect(enrichment.stats?.requestsIssued).toBe(1)
  })

  it("disables the language when didOpen keeps reporting the server is gone", async () => {
    // The escalation path the per-file design leans on: a transport broken for
    // good fails every subsequent didOpen, and five such files disable the
    // language rather than letting the pass talk to a dead server all run.
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]
    const captured: { client: MockLspClient | null } = { client: null }
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installDidOpenOutcome(() => ({
        kind: "error",
        reason: "server-disconnected",
        message: "server exited",
      }))
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: files.flatMap(classWithMethod),
        fileContents: Object.fromEntries(files.map((file) => [file, FILE_SOURCE])),
        serverFactory: factory,
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(5)
    expect(enrichment.stats?.filesEnriched).toBe(0)
    expect(enrichment.stats?.languagesDisabled).toContain("ts")
    expect(captured.client?.requests).toEqual([])
  })

  it("fires per-file fallback when didOpen alone consumes the file budget", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const clock = makeManualClock()
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      // fileBudgetMs is 500 in makeServerConfig — didOpen overspends it by 100.
      client.installDidOpenOutcome(() => {
        clock.advance(600)
        return null
      })
      client.installHandler(DOC_SYMBOL_METHOD, () => [FOO_DOC_SYMBOL])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: classWithMethod("src/a.ts"),
        fileContents: { "src/a.ts": FILE_SOURCE },
        serverFactory: factory,
        now: clock.now,
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(1)
    expect(enrichment.stats?.requestsIssued).toBe(0)
    expect(captured.client?.requests).toEqual([])
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, null])
  })

  it("spends the file budget without exceeding it when didOpen lands exactly on it", async () => {
    const clock = makeManualClock()
    const factory = mockServerFactory((_lang, client) => {
      // Exactly fileBudgetMs: the budget is spent, not exceeded, so the file
      // still gets its documentSymbol round-trip.
      client.installDidOpenOutcome(() => {
        clock.advance(500)
        return null
      })
      client.installHandler(DOC_SYMBOL_METHOD, () => [FOO_DOC_SYMBOL])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: classWithMethod("src/a.ts"),
        fileContents: { "src/a.ts": FILE_SOURCE },
        serverFactory: factory,
        now: clock.now,
      }),
    )
    expect(enrichment.stats?.filesFellBack).toBe(0)
    expect(enrichment.stats?.filesEnriched).toBe(1)
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, 3])
  })

  it("keeps a file enriched when only its didClose notification fails", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installDidCloseOutcome(() => LSP_TIMEOUT)
      client.installHandler(DOC_SYMBOL_METHOD, () => [FOO_DOC_SYMBOL])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: classWithMethod("src/a.ts"),
        fileContents: { "src/a.ts": FILE_SOURCE },
        serverFactory: factory,
      }),
    )
    expect(enrichment.stats?.filesEnriched).toBe(1)
    expect(enrichment.stats?.filesFellBack).toBe(0)
    // The enrichment the file did earn is kept, not rolled back.
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, 3])
    // Notification bounds come from the existing knobs, not a new one:
    // didOpen gets the whole file budget, didClose the per-request budget.
    expect(captured.client?.openTimeouts).toEqual([500])
    expect(captured.client?.closeTimeouts).toEqual([100])
  })

  it("warns about a failed didOpen and only debug-logs a failed didClose", async () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const factory = mockServerFactory((_lang, client) => {
      client.installDidOpenOutcome((uri) => (uri.endsWith("src/a.ts") ? LSP_TIMEOUT : null))
      client.installDidCloseOutcome((uri) => (uri.endsWith("src/b.ts") ? LSP_TIMEOUT : null))
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
    })
    const input = makeEnrichmentInput({
      symbols: ["src/a.ts", "src/b.ts"].flatMap(classWithMethod),
      fileContents: { "src/a.ts": FILE_SOURCE, "src/b.ts": FILE_SOURCE },
      serverFactory: factory,
    })
    await enrichWithLsp({ ...input, logger: { debug, info: () => {}, warn, error: () => {} } })
    expect(warn.mock.calls.flat()).toEqual([expect.stringContaining("didOpen failed for src/a.ts")])
    expect(debug.mock.calls.flat()).toEqual([
      expect.stringContaining("didClose failed for src/b.ts"),
    ])
  })
})

const FILE_SOURCE = "class C {\n  foo() {}\n}"

/** `foo` at line 2, columns 3..13 — what `columnsOf` reads back as `3`. */
const FOO_DOC_SYMBOL = {
  name: "foo",
  kind: 6,
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 12 } },
  selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
}

function classWithMethod(file: string) {
  return [makeClassSymbol(file, "C", 1), makeMethodSymbol(file, "C", "foo", 2)]
}

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
