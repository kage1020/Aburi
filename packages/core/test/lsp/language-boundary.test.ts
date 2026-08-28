import type { Symbol as IRSymbol, LanguageId, Logger } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol"
import { makeLanguageId } from "../../src/id"
import { enrichWithLsp } from "../../src/lsp"
import { makeSymbol } from "../fixtures/ir"
import {
  makeClassSymbol,
  makeEnrichmentInput,
  makeLspConfig,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import { type MockLspClient, mockServerFactory } from "./fixtures/mock-server"

/**
 * The enrichment pass is optional by design and degrades in three tiers
 * (lsp-enrichment.md §6.1), so nothing that happens inside one language may end the scan or
 * outlive the language it happened in. The server is a child process: a throw that skips
 * `shutdown` leaves it running for the rest of the run and past it.
 */

const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
    },
  }
}

/** The pass's own line for a language it gave up on, apart from any other warning. */
function fallbackWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((w) => w.includes("falling back to untyped tier"))
}

function pySymbol(file: string, name: string, line: number): IRSymbol {
  return makeSymbol(`py:${file}#${name}`, {
    language: makeLanguageId("py"),
    name,
    source: { file, startLine: line, endLine: line, startColumn: null, endColumn: null },
  })
}

/** A documentSymbol entry naming `name` at `line`, 0-based the way LSP sends it. */
function docSymbol(name: string, line: number, startCol: number, children?: DocumentSymbol[]) {
  const entry = {
    name,
    kind: 5,
    range: {
      start: { line: line - 1, character: startCol },
      end: { line: line - 1, character: startCol + 4 },
    },
    selectionRange: {
      start: { line: line - 1, character: startCol },
      end: { line: line - 1, character: startCol + 4 },
    },
  } as DocumentSymbol
  if (children !== undefined) entry.children = children
  return entry
}

describe("a throw inside one language is a per-language fallback", () => {
  /** A client whose `documentSymbol` rejects — an injected client is free to throw. */
  function throwingFactory(clients: Map<LanguageId, MockLspClient>) {
    return mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => {
        throw new Error("server handler exploded")
      })
    })
  }

  it("does not escape enrichWithLsp, and hands back the symbols it was given", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const cls = makeClassSymbol("src/a.ts", "C", 1)

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [cls],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: throwingFactory(clients),
      }),
    )

    expect(result.symbols.map((s) => s.id)).toEqual([cls.id])
  })

  it("shuts the server down, so no child process outlives the pass", async () => {
    const clients = new Map<LanguageId, MockLspClient>()

    await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: throwingFactory(clients),
      }),
    )

    expect(clients.get(makeLanguageId("ts"))?.shutdownCount).toBe(1)
  })

  it("records the language as disabled and warns once, quoting what was thrown", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), makeClassSymbol("src/b.ts", "D", 1)],
        fileContents: { "src/a.ts": "class C {}\n", "src/b.ts": "class D {}\n" },
        serverFactory: throwingFactory(clients),
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    const fallbacks = fallbackWarnings(warnings)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain("ts")
    expect(fallbacks[0]).toContain("server handler exploded")
  })

  it("leaves the failed language's symbols at the untyped tier", async () => {
    // §6.2: the columns keep the value the Tree-sitter tier wrote. A fallback never lowers
    // anything, and it never invents anything either.
    const clients = new Map<LanguageId, MockLspClient>()

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: throwingFactory(clients),
      }),
    )

    expect(result.symbols[0]?.source.startColumn).toBeNull()
    expect(result.symbols[0]?.source.endColumn).toBeNull()
  })

  it("keeps what the language enriched before it threw", async () => {
    // No rollback, deliberately. A file that was enriched stays enriched — §6.2 forbids a
    // fallback lowering a value the pass had already earned.
    const clients = new Map<LanguageId, MockLspClient>()
    let call = 0
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => {
        call += 1
        if (call === 1) return [docSymbol("C", 1, 6)]
        throw new Error("server handler exploded")
      })
    })

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), makeClassSymbol("src/b.ts", "D", 1)],
        fileContents: { "src/a.ts": "class C {}\n", "src/b.ts": "class D {}\n" },
        serverFactory: factory,
      }),
    )

    const first = result.symbols.find((s) => s.source.file === "src/a.ts")
    expect(first?.source.startColumn).toBe(7)
  })

  it("carries on to the next language, and shuts that server down too", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => {
        if (language === "ts") throw new Error("server handler exploded")
        return [docSymbol("beta", 1, 4)]
      })
    })
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), pySymbol("src/b.py", "beta", 1)],
        fileContents: { "src/a.ts": "class C {}\n", "src/b.py": "def beta(): pass\n" },
        serverFactory: factory,
        lspConfig: makeLspConfig({
          servers: { ts: makeServerConfig(), py: makeServerConfig() },
        }),
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(clients.get(makeLanguageId("py"))?.shutdownCount).toBe(1)
    expect(result.symbols.find((s) => s.language === "py")?.source.startColumn).toBe(5)
    expect(fallbackWarnings(warnings)).toHaveLength(1)
  })

  it("treats an initialize that rejects the same way as one that fails", async () => {
    // `initialize` is called outside every guard the file already had, so a client free to
    // throw could leak its server before the pass had done anything at all.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installInitializeThrow(new Error("initialize exploded"))
    })
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(clients.get(makeLanguageId("ts"))?.shutdownCount).toBe(1)
    expect(fallbackWarnings(warnings)[0]).toContain("initialize exploded")
  })
})

describe("the server is shut down exactly once", () => {
  it("on the healthy path", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
    })

    await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(clients.get(makeLanguageId("ts"))?.shutdownCount).toBe(1)
  })

  it("and a shutdown that fails is said out loud rather than swallowed", async () => {
    // It runs in a `finally`, so it cannot be allowed to propagate — but a shutdown that
    // failed means a child process that may still be running, which is exactly what the call
    // exists to prevent and the one thing nothing else in the run would report.
    const factory = mockServerFactory((_language, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installShutdownThrow(new Error("pipe already closed"))
    })
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
      logger,
    })

    expect(result.symbols).toHaveLength(1)
    const shutdownWarnings = warnings.filter((w) => w.includes("may still be running"))
    expect(shutdownWarnings).toHaveLength(1)
    expect(shutdownWarnings[0]).toContain("pipe already closed")
    // The language still enriched: a shutdown is the last thing that happens to it.
    expect(result.stats?.languagesDisabled).toEqual([])
  })

  it("when initialize reports a failure rather than throwing", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installInitializeFailure({
        kind: "error",
        reason: "server-error",
        message: "no capabilities",
      })
    })

    await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(clients.get(makeLanguageId("ts"))?.shutdownCount).toBe(1)
  })
})

describe("applying a documentSymbol tree", () => {
  /** A chain `depth` entries long, each one the only child of the one above it. */
  function nested(depth: number, leafName: string, leafLine: number): DocumentSymbol {
    let entry = docSymbol(leafName, leafLine, 6)
    for (let i = 0; i < depth; i++) entry = docSymbol(`filler${i}`, 900 + i, 0, [entry])
    return entry
  }

  it("applies an entry nested deeper than the call stack would allow", async () => {
    // A server is free to answer with whatever nesting its language has. Recursion here read
    // that as a `RangeError` out of the pass, which took the scan with it.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [nested(50_000, "C", 1)])
    })

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(result.symbols[0]?.source.startColumn).toBe(7)
    expect(result.stats?.languagesDisabled).toEqual([])
  })

  it("keeps the order the walk visits entries in, so the outer of two matches wins", async () => {
    // Matching is by (startLine, last name segment) and takes the first hit, so which entry
    // the walk reaches first decides the columns. Pre-order puts the parent ahead of its
    // child; a stack that pushed children in source order would silently reverse siblings.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [
        docSymbol("C", 1, 6, [docSymbol("C", 1, 20)]),
        docSymbol("D", 2, 30),
      ])
    })

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(result.symbols[0]?.source.startColumn).toBe(7)
  })

  it("keeps sibling order, so the first of two entries on one line wins", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [
        docSymbol("wrapper", 5, 0, [docSymbol("C", 1, 6), docSymbol("C", 1, 40)]),
      ])
    })

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(result.symbols[0]?.source.startColumn).toBe(7)
  })

  it("still applies a flat SymbolInformation answer", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [
        {
          name: "C",
          kind: 5,
          location: {
            uri: "file:///workspace/src/a.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 10 },
            },
          },
        } as SymbolInformation,
      ])
    })

    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: factory,
      }),
    )

    expect(result.symbols[0]?.source.startColumn).toBe(7)
  })
})
