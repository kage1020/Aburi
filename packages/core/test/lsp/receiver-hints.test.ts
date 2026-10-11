import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
import type { EnrichmentResult } from "../../src/lsp"
import {
  enrich,
  makeClassSymbol,
  makeMethodSymbol,
  THIS_FOO_CALLER,
  thisFooFile,
} from "./fixtures/enrichment-ctx"
import { hoverServer } from "./fixtures/mock-server"

function resolveWith(enrichment: EnrichmentResult) {
  return resolveCallGraph({
    symbols: enrichment.symbols,
    importsByFile: new Map(),
    receiverHints: enrichment.receiverHints,
    implementerHints: enrichment.implementerHints,
  })
}

const SUPER_FOO_SOURCE =
  "class Base {\n  foo() {}\n}\nclass Sub extends Base {\n  foo() {\n    super.foo()\n  }\n}"

describe("receiver hints", () => {
  it("resolves `this.foo()` to the class's own member at high confidence, where the untyped tier cannot", async () => {
    const untyped = resolveCallGraph({ symbols: thisFooFile().symbols, importsByFile: new Map() })
    expect(untyped.edges).toEqual([])

    const enrichment = await enrich({
      ...thisFooFile(),
      serverFactory: hoverServer(() => ({
        contents: { kind: "markdown", value: "(method) C.foo(): void" },
      })),
    })

    expect(enrichment.receiverHints).toEqual(
      new Map([
        [
          makeCallSiteKey("src/a.ts", 4, "this.foo"),
          { kind: "this", targetSymbolId: "ts:src/a.ts#C.foo" },
        ],
      ]),
    )
    expect(resolveWith(enrichment).edges).toEqual([
      { from: THIS_FOO_CALLER, to: "ts:src/a.ts#C.foo", via: "call", confidence: "high", line: 4 },
    ])
  })

  it("resolves `super.foo()` to the base member the hover names", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "Base", 1),
        makeMethodSymbol("src/a.ts", "Base", "foo", 2),
        makeClassSymbol("src/a.ts", "Sub", 4),
        makeMethodSymbol("src/a.ts", "Sub", "foo", 5, [{ target: "super.foo", line: 6 }]),
      ],
      fileContents: { "src/a.ts": SUPER_FOO_SOURCE },
      serverFactory: hoverServer(() => ({ contents: "(method) Base.foo(): void" })),
    })

    expect(enrichment.receiverHints.get(makeCallSiteKey("src/a.ts", 6, "super.foo"))).toEqual({
      kind: "super",
      targetSymbolId: "ts:src/a.ts#Base.foo",
    })
    const result = resolveWith(enrichment)
    expect(result.edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ["ts:src/a.ts#Sub.foo", "ts:src/a.ts#Base.foo", "high"],
    ])
    expect(result.diagnostics).toEqual([])
  })

  it("resolves a `#`-private member, which keeps its `#` in the Symbol table", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "#v", 2),
        makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.#v", line: 4 }]),
      ],
      fileContents: { "src/a.ts": "class C {\n  #v() {}\n  bar() {\n    this.#v()\n  }\n}" },
      serverFactory: hoverServer(() => ({ contents: "(method) C.#v(): void" })),
    })

    expect([...enrichment.receiverHints.values()]).toEqual([
      { kind: "this", targetSymbolId: "ts:src/a.ts#C.#v" },
    ])
  })

  it("finds the hovered class and its member in another file of the caller's language", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/base.ts", "Base", 1),
        makeMethodSymbol("src/base.ts", "Base", "foo", 2),
        makeClassSymbol("src/sub.ts", "Sub", 1),
        makeMethodSymbol("src/sub.ts", "Sub", "foo", 2, [{ target: "super.foo", line: 3 }]),
      ],
      fileContents: {
        "src/base.ts": "class Base {\n  foo() {}\n}",
        "src/sub.ts": "class Sub extends Base {\n  foo() {\n    super.foo()\n  }\n}",
      },
      serverFactory: hoverServer(() => ({ contents: "(method) Base.foo(): void" })),
    })

    expect([...enrichment.receiverHints.values()]).toEqual([
      { kind: "super", targetSymbolId: "ts:src/base.ts#Base.foo" },
    ])
  })

  it("prefers the class and member declared in the caller's own file", async () => {
    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeClassSymbol("src/b.ts", "C", 1),
        makeMethodSymbol("src/b.ts", "C", "foo", 2),
        makeMethodSymbol("src/b.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }]),
      ],
      fileContents: {
        "src/a.ts": "class C {\n  foo() {}\n}",
        "src/b.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}",
      },
      serverFactory: hoverServer(() => ({ contents: "(method) C.foo(): void" })),
    })

    expect([...enrichment.receiverHints.values()]).toEqual([
      { kind: "this", targetSymbolId: "ts:src/b.ts#C.foo" },
    ])
  })

  it("asks for no hint on a `this.a.b` target, whose callee is not where it would look", async () => {
    const run = makeMethodSymbol("src/a.ts", "C", "run", 3, [
      { target: "this.emitter.emit", line: 4 },
    ])
    const factory = hoverServer(() => ({ contents: "(property) C.emitter: EventEmitter" }))

    const enrichment = await enrich({
      symbols: [
        makeClassSymbol("src/a.ts", "C", 1),
        makeMethodSymbol("src/a.ts", "C", "emit", 2),
        run,
      ],
      fileContents: {
        "src/a.ts": "class C {\n  emit() {}\n  run() {\n    this.emitter.emit(1)\n  }\n}",
      },
      serverFactory: factory,
    })

    expect(factory.clients.get("ts")?.requests.map((r) => r.method)).toEqual([
      "textDocument/documentSymbol",
    ])
    expect(enrichment.receiverHints.size).toBe(0)
    const result = resolveWith(enrichment)
    expect(result.edges).toEqual([])
    expect(result.symbols.find((sym) => sym.id === run.id)?.calls[0]?.resolved).toBeNull()
  })
})
