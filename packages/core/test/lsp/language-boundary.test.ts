import { recordingLogger } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { makeLanguageId } from "../../src/id"
import { makeSymbol } from "../fixtures/ir"
import {
  enrich,
  makeClassSymbol,
  makeLspConfig,
  makeMethodSymbol,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import {
  DOC_SYMBOL_METHOD,
  docSymbol,
  documentSymbolServer,
  HOVER_METHOD,
  hoverPosition,
  mockServerFactory,
} from "./fixtures/mock-server"

function fallbackWarnings(warnings: readonly string[]): string[] {
  return warnings.filter(
    (w) => w.includes("falling back to untyped tier") || w.includes("disabling LSP for"),
  )
}

function throwingServer() {
  return documentSymbolServer(() => {
    throw new Error("server handler exploded")
  })
}

const ONE_CLASS = {
  symbols: [makeClassSymbol("src/a.ts", "C", 1)],
  fileContents: { "src/a.ts": "class C {}\n" },
}

const TWO_FILES = {
  symbols: [makeClassSymbol("src/a.ts", "C", 1), makeClassSymbol("src/b.ts", "D", 1)],
  fileContents: { "src/a.ts": "class C {}\n", "src/b.ts": "class D {}\n" },
}

describe("a throw inside one language is a per-language fallback", () => {
  it("does not escape, hands back the symbols unenriched, and shuts the server down", async () => {
    const factory = throwingServer()

    const result = await enrich({ ...ONE_CLASS, serverFactory: factory })

    expect(result.symbols.map((s) => s.id)).toEqual(["ts:src/a.ts#C"])
    expect(result.symbols[0]?.source.startColumn).toBeNull()
    expect(result.symbols[0]?.source.endColumn).toBeNull()
    expect(factory.clients.get("ts")?.shutdownCount).toBe(1)
  })

  it("records the language as disabled and warns once, quoting what was thrown", async () => {
    const logger = recordingLogger()

    const result = await enrich({ ...TWO_FILES, serverFactory: throwingServer(), logger })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    const fallbacks = fallbackWarnings(logger.warnings)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain("ts")
    expect(fallbacks[0]).toContain("server handler exploded")
  })

  it("carries the class and the stack on the debug channel, where the warning cannot", async () => {
    const logger = recordingLogger()

    await enrich({ ...ONE_CLASS, serverFactory: throwingServer(), logger })

    const threw = logger.debugs.filter((d) => d.message.includes("threw"))
    expect(threw).toHaveLength(1)
    expect(threw[0]?.meta?.error).toBe("Error")
    expect(String(threw[0]?.meta?.stack)).toContain("server handler exploded")
  })

  it("keeps what the language enriched before it threw", async () => {
    let call = 0
    const logger = recordingLogger()

    const result = await enrich({
      ...TWO_FILES,
      serverFactory: documentSymbolServer(() => {
        call += 1
        if (call === 1) return [docSymbol("C", 1, 6)]
        throw new Error("server handler exploded")
      }),
      logger,
    })

    expect(result.symbols.find((sym) => sym.source.file === "src/a.ts")?.source.startColumn).toBe(7)
    expect(fallbackWarnings(logger.warnings)).toHaveLength(1)
    expect(result.stats?.filesEnriched).toBe(1)
    expect(result.stats?.filesFellBack).toBe(0)
  })

  it("carries on to the languages after it, and shuts each server down", async () => {
    const factory = mockServerFactory((client, language) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => {
        if (language === "py") throw new Error("server handler exploded")
        return [docSymbol(language === "go" ? "Alpha" : "C", 1, 4)]
      })
    })
    const logger = recordingLogger()

    const result = await enrich({
      symbols: [
        makeSymbol("go:src/a.go#Alpha", { language: makeLanguageId("go") }),
        makeSymbol("py:src/b.py#beta", { language: makeLanguageId("py") }),
        makeClassSymbol("src/c.ts", "C", 1),
      ],
      fileContents: {
        "src/a.go": "func Alpha() {}\n",
        "src/b.py": "def beta(): pass\n",
        "src/c.ts": "class C {}\n",
      },
      serverFactory: factory,
      lspConfig: makeLspConfig({
        servers: { go: makeServerConfig(), py: makeServerConfig(), ts: makeServerConfig() },
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["py"])
    expect(fallbackWarnings(logger.warnings)).toHaveLength(1)
    expect([...factory.clients.values()].map((client) => client.shutdownCount)).toEqual([1, 1, 1])
    expect(result.symbols.find((sym) => sym.language === "ts")?.source.startColumn).toBe(5)
    expect(result.symbols.find((sym) => sym.language === "go")?.source.startColumn).toBe(5)
  })
})

describe("a throw from a concurrent job", () => {
  const FOUR_CALLS = {
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
  }

  /** The first hover throws at once; the others answer after a delay. */
  function slowExplodingServer() {
    let call = 0
    return mockServerFactory((client) => {
      client.installHandler(HOVER_METHOD, async () => {
        call += 1
        if (call === 1) throw new Error("hover exploded")
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { contents: "(method) C.foo(): void" }
      })
    })
  }

  it("does not let an abandoned worker write into a Document that was already returned", async () => {
    const factory = slowExplodingServer()

    const result = await enrich({ ...FOUR_CALLS, serverFactory: factory })

    const hintsAtReturn = result.receiverHints.size
    const requestsAtReturn = factory.clients.get("ts")?.requests.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(result.receiverHints.size).toBe(hintsAtReturn)
    expect(factory.clients.get("ts")?.requests.length).toBe(requestsAtReturn)
  })

  it("keeps what the file earned before the throw: the three hovers that answered", async () => {
    const result = await enrich({ ...FOUR_CALLS, serverFactory: slowExplodingServer() })

    expect([...result.receiverHints.keys()].sort()).toEqual(
      [5, 6, 7].map((line) => makeCallSiteKey("src/a.ts", line, "this.foo")),
    )
    for (const hint of result.receiverHints.values()) {
      expect(hint.targetSymbolId).toBe("ts:src/a.ts#C.foo")
    }
  })

  it("still reaches the language boundary, so the language is disabled and the server closed", async () => {
    const factory = slowExplodingServer()
    const logger = recordingLogger()

    const result = await enrich({ ...FOUR_CALLS, serverFactory: factory, logger })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(factory.clients.get("ts")?.shutdownCount).toBe(1)
    expect(fallbackWarnings(logger.warnings)[0]).toContain("hover exploded")
  })

  it("reports the earliest job's failure, not the one that arrived first", async () => {
    const logger = recordingLogger()

    await enrich({
      ...FOUR_CALLS,
      serverFactory: mockServerFactory((client) => {
        client.installHandler(HOVER_METHOD, async (params) => {
          const line = hoverPosition(params).line + 1
          if (line === 4) await new Promise((resolve) => setTimeout(resolve, 30))
          throw new Error(`hover on line ${line} exploded`)
        })
      }),
      logger,
    })

    const fallbacks = fallbackWarnings(logger.warnings)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain("hover on line 4 exploded")
  })
})
