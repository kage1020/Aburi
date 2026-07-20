import { describe, expect, it } from "vitest"
import { enrichWithLsp, LSP_TIMEOUT } from "../../src/lsp"
import {
  makeClassSymbol,
  makeEnrichmentInput,
  makeLspConfig,
  makeMethodSymbol,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import { type MockLspClient, mockServerFactory, nullServerFactory } from "./fixtures/mock-server"

describe("LSP protocol", () => {
  it("initializes, opens the file, requests documentSymbol, and populates columns", async () => {
    const captured: { client: MockLspClient | null } = { client: null }
    const factory = mockServerFactory((_lang, client) => {
      captured.client = client
      client.installHandler("textDocument/documentSymbol", () => [
        {
          name: "helper",
          kind: 12,
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 20 },
          },
          selectionRange: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 10 },
          },
        },
      ])
    })
    const symbols = [
      makeMethodSymbol("src/a.ts", "helper", "run", 1).calls.length === 0
        ? makeSimple("helper", "src/a.ts", 1)
        : makeSimple("helper", "src/a.ts", 1),
    ]
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: { "src/a.ts": "    helper() {}" },
        serverFactory: factory,
      }),
    )
    expect(captured.client?.initializeCalled).toBe(true)
    expect(captured.client?.openFiles.length).toBe(1)
    expect(captured.client?.closedFiles.length).toBe(1)
    expect(captured.client?.shutdownCalled).toBe(true)
    const enriched = result.symbols[0]
    expect(enriched?.source.startColumn).toBe(5)
    expect(enriched?.source.endColumn).toBe(21)
  })

  it("falls back per-language when the server binary cannot be spawned", async () => {
    const symbols = [makeSimple("helper", "src/a.ts", 1)]
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: { "src/a.ts": "helper() {}" },
        serverFactory: nullServerFactory(),
      }),
    )
    expect(result.stats?.languagesDisabled).toContain("ts")
    // IR still produced from the untyped tier — SourceRange columns stay null.
    expect(result.symbols[0]?.source.startColumn).toBeNull()
  })

  it("disables the language when consecutive files hit per-file fallback", async () => {
    // Each file has 3 call sites; each hover call fails after file 1. Per-request
    // fallback fires 3× on a single file → per-file fallback → after 5 such files
    // → per-language fallback.
    let firstFileServed = false
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler("textDocument/documentSymbol", () => [])
      client.installHandler("textDocument/hover", () => {
        if (!firstFileServed) {
          firstFileServed = true
          return { contents: "(method) M.helper(): void" }
        }
        return { kind: "error", reason: "server-disconnected", message: "SIGKILL" } as const
      })
    })
    const cls = makeClassSymbolLike("src/a.ts", "M", 1)
    const makeCaller = (file: string) => ({
      ...makeClassSymbolLike(file, "M", 1),
      kind: "method" as const,
      name: "M.caller",
      id: `ts:${file}#M.caller`,
      calls: [
        { target: "this.helper", line: 2, resolved: null },
        { target: "this.helper", line: 3, resolved: null },
        { target: "this.helper", line: 4, resolved: null },
      ],
      source: { file, startLine: 1, endLine: 4, startColumn: null, endColumn: null },
    })
    const helperFor = (file: string) => ({
      ...makeClassSymbolLike(file, "M", 5),
      kind: "method" as const,
      name: "M.helper",
      id: `ts:${file}#M.helper`,
    })
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]
    const symbols = files.flatMap((f) => [
      {
        ...cls,
        id: `ts:${f}#M`,
        source: { file: f, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
      },
      makeCaller(f),
      helperFor(f),
    ])
    const contents: Record<string, string> = {}
    for (const f of files) {
      contents[f] = "class M {\n  this.helper()\n  this.helper()\n  this.helper()\n  helper() {}\n}"
    }
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: contents,
        serverFactory: factory,
        lspConfig: makeLspConfig({
          servers: { ts: makeServerConfig({ concurrency: 1 }) },
        }),
      }),
    )
    expect(result.stats?.filesFellBack).toBeGreaterThanOrEqual(5)
    expect(result.stats?.languagesDisabled).toContain("ts")
  })

  it("passes through untouched when lsp.enabled is false", async () => {
    const symbols = [makeSimple("helper", "src/a.ts", 1)]
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: { "src/a.ts": "helper() {}" },
        serverFactory: nullServerFactory(),
        lspConfig: { enabled: false },
      }),
    )
    expect(result.stats).toBeUndefined()
    expect(result.receiverHints.size).toBe(0)
    expect(result.symbols[0]?.source.startColumn).toBeNull()
  })
})

// helper to build a simple function symbol with the given file+line
function makeSimple(name: string, file: string, line: number) {
  return {
    ...makeClassSymbol(file, name, line),
    kind: "function" as const,
    name,
  }
}

const makeClassSymbolLike = makeClassSymbol
void LSP_TIMEOUT
