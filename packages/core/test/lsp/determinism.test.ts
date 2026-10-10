import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { resolveCallGraph } from "../../src/callgraph"
import {
  enrich,
  makeClassSymbol,
  makeMethodSymbol,
  tsServer,
  workspaceUri,
} from "./fixtures/enrichment-ctx"
import { HOVER_METHOD, hoverPosition, hoverServer } from "./fixtures/mock-server"

function sortedEntries(map: ReadonlyMap<string, unknown>): string {
  return JSON.stringify([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

describe("LSP determinism", () => {
  it("produces identical output for concurrency 1 and 8, including symbols and stats", async () => {
    const run = (concurrency: number) =>
      enrich({
        symbols: [
          makeClassSymbol("src/a.ts", "C", 1),
          makeMethodSymbol("src/a.ts", "C", "foo", 2),
          makeMethodSymbol("src/a.ts", "C", "bar", 3, [
            { target: "this.foo", line: 4 },
            { target: "this.foo", line: 5 },
            { target: "this.foo", line: 6 },
          ]),
        ],
        fileContents: {
          "src/a.ts":
            "class C {\n  foo() {}\n  bar() {\n    this.foo()\n    this.foo()\n    this.foo()\n  }\n}",
        },
        serverFactory: hoverServer(async () => {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)))
          return { contents: "(method) C.foo(): void\n@throws {Gone}" }
        }),
        lspConfig: tsServer({ concurrency }),
      })

    const [one, eight] = [await run(1), await run(8)]

    expect(sortedEntries(one.receiverHints)).toBe(sortedEntries(eight.receiverHints))
    expect(JSON.stringify(one.symbols)).toBe(JSON.stringify(eight.symbols))
    expect(one.stats).toEqual(eight.stats)
  })

  it("opens files in path order and hovers in (Symbol id, line, target) order, whatever order the Symbols arrive in", async () => {
    const factory = hoverServer(() => null)

    await enrich({
      symbols: [
        makeClassSymbol("src/b.ts", "D", 1),
        makeMethodSymbol("src/a.ts", "C", "z", 4, [{ target: "this.foo", line: 5 }]),
        makeMethodSymbol("src/a.ts", "C", "a", 7, [
          { target: "this.foo", line: 9 },
          { target: "this.foo", line: 8 },
          { target: "this.baz", line: 8 },
        ]),
        makeMethodSymbol("src/a.ts", "C", "foo", 2),
        makeMethodSymbol("src/a.ts", "C", "baz", 3),
        makeClassSymbol("src/a.ts", "C", 1),
      ],
      fileContents: {
        "src/a.ts": [
          "class C {",
          "  foo() {}",
          "  baz() {}",
          "  z() {",
          "    this.foo()",
          "  }",
          "  a() {",
          "    this.foo(this.baz())",
          "    this.foo()",
          "  }",
          "}",
        ].join("\n"),
        "src/b.ts": "class D {}",
      },
      serverFactory: factory,
      lspConfig: tsServer({ concurrency: 1 }),
    })

    const client = factory.clients.get("ts")
    expect(client?.openFiles).toEqual([workspaceUri("src/a.ts"), workspaceUri("src/b.ts")])
    const hovered = client?.requests
      .filter((request) => request.method === HOVER_METHOD)
      .map((request) => hoverPosition(request.params))
      .map(({ line, character }) => [line + 1, character])
    expect(hovered).toEqual([
      [8, "    this.foo(this.".length],
      [8, "    this.".length],
      [9, "    this.".length],
      [5, "    this.".length],
    ])
  })

  it("gives each call on a shared line its own hint, whichever hover answers first", async () => {
    const CALL_LINE = "    this.foo(this.baz())"
    const columnOf = (method: string) => CALL_LINE.indexOf(`this.${method}`) + "this.".length
    const run = (slowMethod: string) =>
      enrich({
        symbols: [
          makeClassSymbol("src/a.ts", "C", 1),
          makeMethodSymbol("src/a.ts", "C", "foo", 2),
          makeMethodSymbol("src/a.ts", "C", "baz", 3),
          makeMethodSymbol("src/a.ts", "C", "bar", 4, [
            { target: "this.foo", line: 5 },
            { target: "this.baz", line: 5 },
          ]),
        ],
        fileContents: {
          "src/a.ts": `class C {\n  foo(v) {}\n  baz() {}\n  bar() {\n${CALL_LINE}\n  }\n}`,
        },
        serverFactory: hoverServer(async (params) => {
          const method = hoverPosition(params).character === columnOf("foo") ? "foo" : "baz"
          if (method === slowMethod) await new Promise((r) => setTimeout(r, 20))
          return { contents: `(method) C.${method}(): void` }
        }),
      })

    const slowFoo = await run("foo")
    const slowBaz = await run("baz")

    expect(sortedEntries(slowFoo.receiverHints)).toBe(sortedEntries(slowBaz.receiverHints))
    expect([...slowFoo.receiverHints].sort()).toEqual([
      [
        makeCallSiteKey("src/a.ts", 5, "this.baz"),
        { kind: "this", targetSymbolId: "ts:src/a.ts#C.baz" },
      ],
      [
        makeCallSiteKey("src/a.ts", 5, "this.foo"),
        { kind: "this", targetSymbolId: "ts:src/a.ts#C.foo" },
      ],
    ])
    const resolved = resolveCallGraph({
      symbols: slowFoo.symbols,
      importsByFile: new Map(),
      receiverHints: slowFoo.receiverHints,
    })
    expect(resolved.edges.map((e) => e.to)).toEqual(["ts:src/a.ts#C.baz", "ts:src/a.ts#C.foo"])
  })
})
