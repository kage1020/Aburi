import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
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

describe("LSP determinism", () => {
  it("produces identical output for concurrency 1 and 8, including symbols and stats", async () => {
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
    // Symbol payloads (columns, inferredThrows) also match byte-for-byte.
    expect(JSON.stringify(r1.symbols)).toBe(JSON.stringify(r8.symbols))
    expect(r1.stats).toEqual(r8.stats)
  })

  it("keeps implementer arrays sorted so upstream ordering never leaks in", async () => {
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

  it("gives each call on a shared line its own hint, whichever hover answers first", async () => {
    // LE24. `this.foo(this.baz())` is one line and two call sites. Keyed by line
    // alone the two collided, and the surviving hint was whichever hover
    // answered last: the same input resolved `this.foo` to `C.baz` against a
    // fast server and to `C.foo` against a slow one. The two runs below invert
    // exactly that latency, so a key that cannot tell the calls apart — or an
    // apply order taken from the responses instead of from the jobs — changes
    // the answer between them.
    const symbols = () => [
      makeClassSymbol("src/a.ts", "C", 1),
      makeMethodSymbol("src/a.ts", "C", "foo", 2),
      makeMethodSymbol("src/a.ts", "C", "baz", 3),
      makeMethodSymbol("src/a.ts", "C", "bar", 4, [
        { target: "this.foo", line: 5 },
        { target: "this.baz", line: 5 },
      ]),
    ]
    const CALL_LINE = "    this.foo(this.baz())"
    const contents = {
      "src/a.ts": `class C {\n  foo(v) {}\n  baz() {}\n  bar() {\n${CALL_LINE}\n  }\n}`,
    }
    // Derived from the fixture rather than written down, because a hard-coded
    // column that misses is invisible: every hover would take the same branch,
    // both runs would be the same execution, and the assertions below would
    // hold for a mock that never dispatched on position at all. This is
    // `findMethodColumn`'s formula — the index of `this.<method>` plus the
    // receiver and its dot — and `assertDispatched` proves it landed.
    const columnOf = (method: string) => CALL_LINE.indexOf(`this.${method}`) + "this.".length
    const FOO_COLUMN = columnOf("foo")
    const BAZ_COLUMN = columnOf("baz")
    const makeFactory = (slowColumn: number, seen: number[]) =>
      mockServerFactory((_lang, client) => {
        client.installHandler(DOC_SYMBOL_METHOD, () => [])
        client.installHandler(HOVER_METHOD, async (params) => {
          const character = (params as { position: { character: number } }).position.character
          seen.push(character)
          if (character === slowColumn) await new Promise((r) => setTimeout(r, 20))
          const method = character === FOO_COLUMN ? "foo" : "baz"
          return { contents: `(method) C.${method}(): void` }
        })
      })
    const run = async (slowColumn: number) => {
      const seen: number[] = []
      const result = await enrichWithLsp(
        makeEnrichmentInput({
          symbols: symbols(),
          fileContents: contents,
          serverFactory: makeFactory(slowColumn, seen),
        }),
      )
      return { result, seen }
    }
    const slowFoo = await run(FOO_COLUMN)
    const slowBaz = await run(BAZ_COLUMN)

    // The latency inversion the test is named for actually happened: each run
    // hovered both receivers, so in each one exactly one of them was the slow
    // hover, and it was the other one between the two runs.
    for (const { seen } of [slowFoo, slowBaz]) {
      expect([...seen].sort((a, b) => a - b)).toEqual([FOO_COLUMN, BAZ_COLUMN])
    }

    expect(serialize(slowFoo.result.receiverHints)).toBe(serialize(slowBaz.result.receiverHints))
    expect([...slowFoo.result.receiverHints].sort()).toEqual([
      [
        makeCallSiteKey("src/a.ts", 5, "this.baz"),
        { kind: "this", targetSymbolId: "ts:src/a.ts#C.baz" },
      ],
      [
        makeCallSiteKey("src/a.ts", 5, "this.foo"),
        { kind: "this", targetSymbolId: "ts:src/a.ts#C.foo" },
      ],
    ])

    // And the hints reach the resolver as two distinct edges rather than one
    // doubled: this is the shape `propagateEffects` consumes.
    const resolved = resolveCallGraph({
      symbols: slowFoo.result.symbols,
      importsByFile: new Map(),
      receiverHints: slowFoo.result.receiverHints,
      implementerHints: slowFoo.result.implementerHints,
    })
    expect(resolved.edges.map((e) => e.to)).toEqual(["ts:src/a.ts#C.baz", "ts:src/a.ts#C.foo"])
  })

  it("produces identical stats when run twice back to back", async () => {
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
