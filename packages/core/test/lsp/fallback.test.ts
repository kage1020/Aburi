import { recordingLogger } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  createFallbackState,
  type EnrichmentResult,
  LSP_TIMEOUT,
  type LspFailure,
} from "../../src/lsp"
import {
  enrich,
  makeClassSymbol,
  makeManualClock,
  makeMethodSymbol,
  thisFooFile,
  tsServer,
} from "./fixtures/enrichment-ctx"
import {
  DOC_SYMBOL_METHOD,
  docSymbol,
  HOVER_METHOD,
  hoverPosition,
  hoverServer,
  mockServerFactory,
} from "./fixtures/mock-server"

const SERVER_GONE: LspFailure = {
  kind: "error",
  reason: "server-disconnected",
  message: "server exited",
}

const FILE_SOURCE = "class C {\n  foo() {}\n}"

function classWithMethod(file: string) {
  return [makeClassSymbol(file, "C", 1), makeMethodSymbol(file, "C", "foo", 2)]
}

function filesOfClassWithMethod(files: readonly string[]) {
  return {
    symbols: files.flatMap(classWithMethod),
    fileContents: Object.fromEntries(files.map((file) => [file, FILE_SOURCE])),
  }
}

/** `foo` on line 2: what `columnsOf` reads back as `[null, 3]`. */
function fooDocumentSymbol() {
  return [docSymbol("foo", 2, 2)]
}

function columnsOf(enrichment: EnrichmentResult, file: string): Array<number | null | undefined> {
  return enrichment.symbols
    .filter((symbol) => symbol.source.file === file)
    .map((symbol) => symbol.source.startColumn)
}

describe("a failed request", () => {
  it.each<[string, LspFailure, "requestsTimedOut" | "requestsFailed"]>([
    ["timed out", LSP_TIMEOUT, "requestsTimedOut"],
    ["failed", { kind: "error", reason: "server-error", message: "injected" }, "requestsFailed"],
  ])("is counted once as %s, never retried, and yields no hint", async (_, failure, counter) => {
    const factory = hoverServer(() => failure)

    const enrichment = await enrich({ ...thisFooFile(), serverFactory: factory })

    expect(
      factory.clients.get("ts")?.requests.filter((r) => r.method === HOVER_METHOD),
    ).toHaveLength(1)
    expect(enrichment.stats).toMatchObject({
      requestsTimedOut: counter === "requestsTimedOut" ? 1 : 0,
      requestsFailed: counter === "requestsFailed" ? 1 : 0,
    })
    expect(enrichment.receiverHints.size).toBe(0)
  })

  it("leaves its sibling request's hint in place", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [
          { target: "this.foo", line: 4 },
          { target: "this.baz", line: 5 },
        ]),
        makeMethodSymbol("src/a.ts", "C", "baz", 6),
      ],
      fileContents: {
        "src/a.ts":
          "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.baz()\n  }\n  baz() {}\n}",
      },
      serverFactory: hoverServer((params) =>
        hoverPosition(params).line === 3 ? LSP_TIMEOUT : { contents: "(method) C.baz(): void" },
      ),
    })

    expect(enrichment.stats?.requestsTimedOut).toBe(1)
    expect([...enrichment.receiverHints.values()]).toEqual([
      { kind: "this", targetSymbolId: "ts:src/a.ts#C.baz" },
    ])
  })
})

describe("per-file fallback", () => {
  it("fires when the file's hovers outrun its budget", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [
          { target: "this.foo", line: 4 },
          { target: "this.foo", line: 5 },
          { target: "this.foo", line: 6 },
          { target: "this.foo", line: 7 },
        ]),
      ],
      fileContents: {
        "src/a.ts":
          "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n    this.foo()\n    this.foo()\n  }\n}",
      },
      serverFactory: hoverServer(async () => {
        await new Promise((r) => setTimeout(r, 80))
        return { contents: "(method) C.foo(): void" }
      }),
      lspConfig: tsServer({ fileBudgetMs: 100, requestTimeoutMs: 500, concurrency: 1 }),
    })

    expect(enrichment.stats?.filesFellBack).toBe(1)
  })

  it("fires for the file whose didOpen timed out, and only that file", async () => {
    const factory = mockServerFactory((client) => {
      client.installDidOpenOutcome((uri) => (uri.endsWith("src/a.ts") ? LSP_TIMEOUT : null))
      client.installHandler(DOC_SYMBOL_METHOD, fooDocumentSymbol)
    })

    const enrichment = await enrich({
      ...filesOfClassWithMethod(["src/a.ts", "src/b.ts"]),
      serverFactory: factory,
    })

    const client = factory.clients.get("ts")
    const requestedUris = client?.requests.map(
      (request) => (request.params as { textDocument: { uri: string } }).textDocument.uri,
    )
    expect(requestedUris?.some((uri) => uri.endsWith("src/a.ts"))).toBe(false)
    expect(client?.closedFiles).toHaveLength(2)
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, null])
    expect(columnsOf(enrichment, "src/b.ts")).toEqual([null, 3])
    expect(enrichment.stats).toMatchObject({
      filesFellBack: 1,
      filesEnriched: 1,
      requestsTimedOut: 0,
      requestsFailed: 0,
      requestsIssued: 1,
    })
  })

  it("fires when didOpen alone consumes the file budget", async () => {
    const clock = makeManualClock()
    const factory = mockServerFactory((client) => {
      client.installDidOpenOutcome(() => {
        clock.advance(600)
        return null
      })
      client.installHandler(DOC_SYMBOL_METHOD, fooDocumentSymbol)
    })

    const enrichment = await enrich({
      ...filesOfClassWithMethod(["src/a.ts"]),
      serverFactory: factory,
      lspConfig: tsServer({ fileBudgetMs: 500 }),
      now: clock.now,
    })

    expect(enrichment.stats).toMatchObject({ filesFellBack: 1, requestsIssued: 0 })
    expect(factory.clients.get("ts")?.requests).toEqual([])
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, null])
  })

  it("does not fire when didOpen spends exactly the file budget", async () => {
    const clock = makeManualClock()

    const enrichment = await enrich({
      ...filesOfClassWithMethod(["src/a.ts"]),
      serverFactory: mockServerFactory((client) => {
        client.installDidOpenOutcome(() => {
          clock.advance(500)
          return null
        })
        client.installHandler(DOC_SYMBOL_METHOD, fooDocumentSymbol)
      }),
      lspConfig: tsServer({ fileBudgetMs: 500 }),
      now: clock.now,
    })

    expect(enrichment.stats).toMatchObject({ filesFellBack: 0, filesEnriched: 1 })
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, 3])
  })

  it("does not fire when only didClose fails, which is given the request budget", async () => {
    const factory = mockServerFactory((client) => {
      client.installDidCloseOutcome(() => LSP_TIMEOUT)
      client.installHandler(DOC_SYMBOL_METHOD, fooDocumentSymbol)
    })

    const enrichment = await enrich({
      ...filesOfClassWithMethod(["src/a.ts"]),
      serverFactory: factory,
      lspConfig: tsServer({ fileBudgetMs: 500, requestTimeoutMs: 100 }),
    })

    expect(enrichment.stats).toMatchObject({ filesEnriched: 1, filesFellBack: 0 })
    expect(columnsOf(enrichment, "src/a.ts")).toEqual([null, 3])
    expect(factory.clients.get("ts")?.openTimeouts).toEqual([500])
    expect(factory.clients.get("ts")?.closeTimeouts).toEqual([100])
  })

  it("warns about a failed didOpen and only debug-logs a failed didClose", async () => {
    const debugs: string[] = []
    const logger = { ...recordingLogger(), debug: (message: string) => debugs.push(message) }

    await enrich({
      ...filesOfClassWithMethod(["src/a.ts", "src/b.ts"]),
      serverFactory: mockServerFactory((client) => {
        client.installDidOpenOutcome((uri) => (uri.endsWith("src/a.ts") ? LSP_TIMEOUT : null))
        client.installDidCloseOutcome((uri) => (uri.endsWith("src/b.ts") ? LSP_TIMEOUT : null))
      }),
      logger,
    })

    expect(logger.warnings).toEqual([expect.stringContaining("didOpen failed for src/a.ts")])
    expect(debugs).toEqual([expect.stringContaining("didClose failed for src/b.ts")])
  })
})

describe("per-language fallback", () => {
  const SIX_FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]

  it("fires after five consecutive files fall back on failed requests, and opens no file after", async () => {
    const factory = hoverServer(() => SERVER_GONE)
    const logger = recordingLogger()

    const enrichment = await enrich({
      symbols: SIX_FILES.flatMap((file) => [
        makeClassSymbol(file, "M", 1),
        makeMethodSymbol(file, "M", "caller", 1, [
          { target: "this.helper", line: 2 },
          { target: "this.helper", line: 3 },
          { target: "this.helper", line: 4 },
        ]),
        makeMethodSymbol(file, "M", "helper", 5),
      ]),
      fileContents: Object.fromEntries(
        SIX_FILES.map((file) => [
          file,
          "class M {\n  this.helper()\n  this.helper()\n  this.helper()\n  helper() {}\n}",
        ]),
      ),
      serverFactory: factory,
      lspConfig: tsServer({ concurrency: 1 }),
      logger,
    })

    expect(enrichment.stats).toMatchObject({
      filesFellBack: 5,
      filesEnriched: 0,
      languagesDisabled: ["ts"],
    })
    expect(factory.clients.get("ts")?.openFiles).toHaveLength(5)
    expect(logger.warnings).toEqual([expect.stringContaining("disabling LSP for ts")])
  })

  it("fires when didOpen keeps reporting the server is gone, before any request", async () => {
    const factory = mockServerFactory((client) => client.installDidOpenOutcome(() => SERVER_GONE))

    const enrichment = await enrich({
      ...filesOfClassWithMethod(SIX_FILES.slice(0, 5)),
      serverFactory: factory,
    })

    expect(enrichment.stats).toMatchObject({
      filesFellBack: 5,
      filesEnriched: 0,
      languagesDisabled: ["ts"],
    })
    expect(factory.clients.get("ts")?.requests).toEqual([])
  })
})

describe("the fallback state", () => {
  it("escalates a file on its third consecutive failed request, a success resetting the count", () => {
    const state = createFallbackState()
    const outcomes = [false, false, true, false, false, false].map(
      (ok) => state.onRequest("src/a.ts", ok).escalate,
    )
    expect(outcomes).toEqual([false, false, false, false, false, true])
  })

  it("escalates a language on its fifth consecutive fallen-back file, an enriched file resetting the count", () => {
    const state = createFallbackState()
    const outcomes = [true, true, true, true, false, true, true, true, true, true].map(
      (fellBack, index) => state.onFileClose(`src/${index}.ts`, "ts", fellBack).escalate,
    )
    expect(outcomes).toEqual([false, false, false, false, false, false, false, false, false, true])
  })

  it("keeps each file's and each language's count apart", () => {
    const state = createFallbackState({ requestsToFile: 2, filesToLanguage: 2 })
    expect(state.onRequest("src/a.ts", false).escalate).toBe(false)
    expect(state.onRequest("src/b.ts", false).escalate).toBe(false)
    expect(state.onFileClose("src/a.ts", "ts", true).escalate).toBe(false)
    expect(state.onFileClose("src/b.go", "go", true).escalate).toBe(false)
  })
})
