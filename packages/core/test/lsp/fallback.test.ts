import { describe, expect, it } from "vitest"
import { enrichWithLsp, LSP_TIMEOUT } from "../../src/lsp"
import {
  makeClassSymbol,
  makeEnrichmentInput,
  makeLspConfig,
  makeMethodSymbol,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

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
})
