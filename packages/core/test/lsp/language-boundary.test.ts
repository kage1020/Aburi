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
  makeMethodSymbol,
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

interface CapturedDebug {
  message: string
  meta: Record<string, unknown> | undefined
}

function capturingLogger(): {
  logger: Logger
  warnings: string[]
  debugs: CapturedDebug[]
} {
  const warnings: string[] = []
  const debugs: CapturedDebug[] = []
  return {
    warnings,
    debugs,
    logger: {
      debug: (message: string, meta?: Record<string, unknown>) => debugs.push({ message, meta }),
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
    },
  }
}

/**
 * The lines §6.3 rule 3 counts: one per language the pass gave up on, whichever of §6.1's
 * three conditions produced it. The streak wording is nothing like the other two, so a filter
 * that matched only "falling back to untyped tier" would return zero for it while looking
 * like the general helper.
 */
function fallbackWarnings(warnings: readonly string[]): string[] {
  return warnings.filter(
    (w) => w.includes("falling back to untyped tier") || w.includes("disabling LSP for"),
  )
}

/**
 * A Symbol in a language other than `ts`. The pass walks languages in ascending id order, so
 * the id decides where in the run a language sits — which is the whole point of the
 * three-language test below.
 */
function foreignSymbol(language: string, file: string, name: string, line: number): IRSymbol {
  return makeSymbol(`${language}:${file}#${name}`, {
    language: makeLanguageId(language),
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

  it("carries the class and the stack on the debug channel, where the warning cannot", async () => {
    // From the language boundary a broken server and a bug in this package are the same
    // event, and by the time a throw has survived every guard `processLanguage` puts on the
    // client, the second is the likelier. The warning cannot say which; this is what does.
    // A debug line is not a CLI warning, so §6.3 rule 3 is untouched.
    const clients = new Map<LanguageId, MockLspClient>()
    const { logger, debugs } = capturingLogger()

    await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1)],
        fileContents: { "src/a.ts": "class C {}\n" },
        serverFactory: throwingFactory(clients),
      }),
      logger,
    })

    const threw = debugs.filter((d) => d.message.includes("threw"))
    expect(threw).toHaveLength(1)
    expect(threw[0]?.meta?.error).toBe("Error")
    expect(String(threw[0]?.meta?.stack)).toContain("server handler exploded")
  })

  it("leaves the failed language's symbols at the untyped tier", async () => {
    // §6.2: a fallback leaves the columns at the `null` the Tree-sitter tier wrote. It
    // invents nothing, the same way it lowers nothing.
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
    // No rollback, deliberately. §6.2's `SourceRange` rule is about the columns the fallback
    // prevented, not the ones it arrived too late to prevent: re-`null`ing an enriched file
    // would make the Document depend on where in the file list the failure landed.
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

    const { logger, warnings } = capturingLogger()
    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [makeClassSymbol("src/a.ts", "C", 1), makeClassSymbol("src/b.ts", "D", 1)],
        fileContents: { "src/a.ts": "class C {}\n", "src/b.ts": "class D {}\n" },
        serverFactory: factory,
      }),
      logger,
    })

    const first = result.symbols.find((sym) => sym.source.file === "src/a.ts")
    expect(first?.source.startColumn).toBe(7)

    // Still one warning, though a file has already been through the pass. This is where rule
    // 3's "exactly one" is easiest to break, because the language line arrives after a file
    // has been counted.
    expect(fallbackWarnings(warnings)).toHaveLength(1)

    // The file the throw happened in is counted nowhere, which is deliberate and matches the
    // initialize-failure path: `filesFellBack` is §6.3 rule 2's per-file tier, and a language
    // that was given up on did not fall back per file — it stopped. `src/a.ts` is enriched
    // because it was, and `src/b.ts` is in neither counter.
    expect(result.stats?.filesEnriched).toBe(1)
    expect(result.stats?.filesFellBack).toBe(0)
  })

  it("carries on to the languages after it, and shuts each server down", async () => {
    // Three languages with the middle one throwing. Languages are walked in ascending id
    // order, so `go` runs before the failure and `ts` after it: one language on each side is
    // what distinguishes "the loop continued" from "the failure happened to be last".
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => {
        if (language === "py") throw new Error("server handler exploded")
        return [docSymbol(language === "go" ? "Alpha" : "C", 1, 4)]
      })
    })
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        symbols: [
          foreignSymbol("go", "src/a.go", "Alpha", 1),
          foreignSymbol("py", "src/b.py", "beta", 1),
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
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["py"])
    expect(fallbackWarnings(warnings)).toHaveLength(1)
    for (const language of ["go", "py", "ts"]) {
      expect(clients.get(makeLanguageId(language))?.shutdownCount).toBe(1)
    }
    // The one that ran after the failure is the assertion the rest of this file cannot make:
    // without it, a `break` in the catch would leave every test here green.
    expect(result.symbols.find((sym) => sym.language === "ts")?.source.startColumn).toBe(5)
    expect(result.symbols.find((sym) => sym.language === "go")?.source.startColumn).toBe(5)
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
  /**
   * Deeper than the JavaScript call stack, with room to spare.
   *
   * Measured on this shape: the recursion this replaced started overflowing at about 8,000
   * levels and did not do so monotonically — 10,000 came back clean after 8,000 had raised
   * `RangeError` — so the number has to be far enough past the cliff that no run of the old
   * code could pass. It costs about 25ms to build and 20MB, against a suite that runs in
   * well under a second.
   */
  const DEPTH_PAST_THE_CALL_STACK = 50_000

  /** A chain `depth` entries long, each one the only child of the one above it. */
  function nested(depth: number, leafName: string, leafLine: number): DocumentSymbol {
    let entry = docSymbol(leafName, leafLine, 6)
    for (let i = 0; i < depth; i++) entry = docSymbol(`filler${i}`, 900 + i, 0, [entry])
    return entry
  }

  it("applies an entry nested deeper than the call stack would allow", async () => {
    // A server is free to answer with whatever nesting its language has. Recursion here read
    // that as a `RangeError` out of the pass, which took the scan with it.
    //
    // The assertion is that the deep entry's columns *land*. "Nothing threw" would now pass
    // on the strength of the language boundary above, which is the other half of this change.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [nested(DEPTH_PAST_THE_CALL_STACK, "C", 1)])
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

  it("visits a parent before its children, so the outer of two matches wins", async () => {
    // Matching is by (startLine, last name segment) and takes the first hit, so which entry
    // the walk reaches first decides the columns. This pair discriminates pre-order from
    // post-order — the recursion this replaced was pre-order, and post-order gives 21 here.
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

  it("keeps sibling order, so the first of two children on one line wins", async () => {
    // A stack pushed in source order pops the last child first, silently reversing siblings.
    // This is the pair that catches it; the parent/child one above cannot, because a parent
    // is on the stack alone.
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

  it("reads a null child list as no children, the way the recursion did", async () => {
    // `entries` is a cast over the server's JSON, so its shape is no more the type's to
    // promise than its depth is, and serializing an empty list as `null` is ordinary. The
    // recursion absorbed it in a `?? []`; reading `.length` off it costs the whole language.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      // Cast because the type cannot hold it, which is the point: the pass casts the same
      // way over the server's JSON and gets whatever the server actually sent.
      const entry = { ...docSymbol("C", 1, 6), children: null } as unknown as DocumentSymbol
      client.installHandler(DOC_SYMBOL_METHOD, () => [entry])
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

  it("keeps top-level order, so the first of two entries on one line wins", async () => {
    // Two entries at the top level on the same line is what an overload set or a declaration
    // merge produces. Nothing else in this file constrains the order the roots come off the
    // stack in, so without this the outer reverse could be deleted and the suite stay green.
    const clients = new Map<LanguageId, MockLspClient>()
    const factory = mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [docSymbol("C", 1, 6), docSymbol("C", 1, 40)])
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

describe("a throw from a concurrent job", () => {
  const HOVER_METHOD = "textDocument/hover"

  /**
   * Four call sites in one method, so `runJobsWithConcurrency` has four jobs to spread over
   * its workers. The first hover throws; the rest answer slowly, which is what makes a worker
   * still in flight when the pass gives up observable.
   */
  function fileWithFourCalls() {
    return {
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
  }

  function slowExplodingFactory(clients: Map<LanguageId, MockLspClient>) {
    let call = 0
    return mockServerFactory((language, client) => {
      clients.set(language, client)
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, async () => {
        call += 1
        if (call === 1) throw new Error("hover exploded")
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { contents: "(method) C.foo(): void" }
      })
    })
  }

  it("does not let an abandoned worker write into a Document that was already returned", async () => {
    // `Promise.all` settles on the first rejection and cancels nothing, so the surviving
    // workers went on calling a shut-down client and writing into the caller's Symbols after
    // the pass had handed them over. An IR that keeps changing after it is returned is the
    // determinism guarantee in §10.6, not untidiness.
    const clients = new Map<LanguageId, MockLspClient>()
    const { logger } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        ...fileWithFourCalls(),
        serverFactory: slowExplodingFactory(clients),
      }),
      logger,
    })

    const atReturn = result.receiverHints.size
    const requestsAtReturn = clients.get(makeLanguageId("ts"))?.requests.length
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(result.receiverHints.size).toBe(atReturn)
    expect(clients.get(makeLanguageId("ts"))?.requests.length).toBe(requestsAtReturn)
  })

  it("still reaches the language boundary, so the language is disabled and the server closed", async () => {
    const clients = new Map<LanguageId, MockLspClient>()
    const { logger, warnings } = capturingLogger()

    const result = await enrichWithLsp({
      ...makeEnrichmentInput({
        ...fileWithFourCalls(),
        serverFactory: slowExplodingFactory(clients),
      }),
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(clients.get(makeLanguageId("ts"))?.shutdownCount).toBe(1)
    expect(fallbackWarnings(warnings)[0]).toContain("hover exploded")
  })
})

describe("a shutdown that never answers", () => {
  it("is bounded and reported, rather than stopping the scan inside the finally", async () => {
    // `serverFactory` is a published seam, and this is the only client call in the pass that
    // had no deadline — awaited from a `finally`, where a hang leaves nothing to read.
    const factory = mockServerFactory((_language, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installShutdownHang()
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
    // A hang and a failure leave the reader with the same server, so they read the same line.
    const stranded = warnings.filter((w) => w.includes("may still be running"))
    expect(stranded).toHaveLength(1)
    expect(stranded[0]).toContain("no answer in")
  })
})
