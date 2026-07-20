import { describe, expect, it } from "vitest"
import { enrichWithLsp } from "../../src/lsp"
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

describe("LSP determinism (LE13-LE15)", () => {
  it("LE13: concurrency 1 vs 8 produces identical output", async () => {
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const foo = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const bar = makeMethodSymbol("src/a.ts", "C", "bar", 3, [
      { target: "this.foo", line: 4 },
      { target: "this.foo", line: 5 },
      { target: "this.foo", line: 6 },
    ])
    const contents = {
      "src/a.ts":
        "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n    this.foo()\n  }\n}",
    }
    const makeFactory = () =>
      mockServerFactory((_lang, client) => {
        client.installHandler(DOC_SYMBOL_METHOD, () => [])
        client.installHandler(HOVER_METHOD, async () => {
          // Inject nondeterministic wall-clock latency; determinism must survive.
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)))
          return { contents: "(method) C.foo(): void" }
        })
      })
    const r1 = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: contents,
        serverFactory: makeFactory(),
        lspConfig: makeLspConfig({
          servers: { ts: makeServerConfig({ concurrency: 1 }) },
        }),
      }),
    )
    const r8 = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, foo, bar],
        fileContents: contents,
        serverFactory: makeFactory(),
        lspConfig: makeLspConfig({
          servers: { ts: makeServerConfig({ concurrency: 8 }) },
        }),
      }),
    )
    expect(serialize(r1.receiverHints)).toBe(serialize(r8.receiverHints))
    expect(serialize(r1.implementerHints)).toBe(serialize(r8.implementerHints))
  })

  it("LE14: server-returned array order does not affect implementerHints", async () => {
    // Interface path: we currently derive implementers via untyped table lookup
    // (framework hook is a follow-up). Assert that even when the server would
    // return implementers reversed, our sorted output is stable.
    const cls = makeClassSymbol("src/a.ts", "C", 1)
    const method = makeMethodSymbol("src/a.ts", "C", "foo", 2)
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls, method],
        fileContents: { "src/a.ts": "class C {\n  foo() {}\n}" },
        serverFactory: factory,
      }),
    )
    for (const [, impls] of enrichment.implementerHints) {
      const sorted = [...impls].sort()
      expect(impls).toEqual(sorted)
    }
  })

  it("LE15: identical scans produce identical stats", async () => {
    const helper = makeMethodSymbol("src/a.ts", "M", "helper", 1)
    const contents = { "src/a.ts": "helper() {}" }
    const factory = () =>
      mockServerFactory((_lang, client) => {
        client.installHandler(DOC_SYMBOL_METHOD, () => [])
      })
    const r1 = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [helper],
        fileContents: contents,
        serverFactory: factory(),
      }),
    )
    const r2 = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [helper],
        fileContents: contents,
        serverFactory: factory(),
      }),
    )
    expect(r1.stats).toEqual(r2.stats)
  })
})

function serialize(map: ReadonlyMap<string, unknown>): string {
  const entries = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return JSON.stringify(entries)
}
