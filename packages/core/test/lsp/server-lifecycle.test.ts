import { recordingLogger } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../../src/id"
import type { LspFailure, ServerFactory } from "../../src/lsp"
import { makeSymbol } from "../fixtures/ir"
import {
  enrich,
  makeClassSymbol,
  makeLspConfig,
  makeServerConfig,
  thisFooFile,
  tsServer,
  workspaceUri,
} from "./fixtures/enrichment-ctx"
import {
  DOC_SYMBOL_METHOD,
  docSymbol,
  documentSymbolServer,
  type MockLspClient,
  mockServerFactory,
} from "./fixtures/mock-server"

describe("a run with no server to talk to", () => {
  it.each<[string, Config["lsp"]]>([
    ["lsp is not enabled", { enabled: false }],
    ["no servers are configured", { enabled: true }],
  ])("hands the symbols back untouched when %s", async (_, lspConfig) => {
    const factory = mockServerFactory()
    const result = await enrich({ ...thisFooFile(), serverFactory: factory, lspConfig })

    expect(result).toEqual({
      symbols: thisFooFile().symbols,
      receiverHints: new Map(),
      implementerHints: new Map(),
      stats: undefined,
    })
    expect(factory.clients.size).toBe(0)
  })

  it("starts no server for a language none is configured for", async () => {
    const factory = mockServerFactory()
    const goSymbol = makeSymbol("go:src/a.go#Alpha", { language: makeLanguageId("go") })

    const result = await enrich({
      symbols: [goSymbol],
      fileContents: { "src/a.go": "func Alpha() {}\n" },
      serverFactory: factory,
    })

    expect(factory.clients.size).toBe(0)
    expect(result.symbols).toEqual([goSymbol])
    expect(result.stats?.languagesDisabled).toEqual([])
  })
})

describe("a server that cannot be had", () => {
  it.each<[string, Partial<{ serverFactory: ServerFactory; lspConfig: Config["lsp"] }>, string]>([
    ["the factory has none", { serverFactory: () => null }, "server not available for ts"],
    [
      "the factory throws",
      {
        serverFactory: () => {
          throw new Error("spawn exploded")
        },
      },
      "spawn exploded",
    ],
    [
      "the configured command does not exist",
      { lspConfig: tsServer({ command: "aburi-no-such-lsp-server" }) },
      "server not available for ts",
    ],
  ])("disables the language when %s, and leaves its columns null", async (_, setup, warning) => {
    const logger = recordingLogger()

    const result = await enrich({
      symbols: [makeClassSymbol("src/a.ts", "C", 1)],
      fileContents: { "src/a.ts": "class C {}" },
      logger,
      ...setup,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(result.symbols[0]?.source.startColumn).toBeNull()
    expect(logger.warnings).toEqual([expect.stringContaining(warning)])
  })
})

describe("the server's lifecycle", () => {
  it("initializes once, opens and closes each file, and shuts the server down once", async () => {
    const factory = documentSymbolServer(() => [])

    await enrich({
      symbols: [makeClassSymbol("src/a.ts", "C", 1), makeClassSymbol("src/b.ts", "D", 1)],
      fileContents: { "src/a.ts": "class C {}", "src/b.ts": "class D {}" },
      serverFactory: factory,
    })

    const client = factory.clients.get("ts")
    const uris = [workspaceUri("src/a.ts"), workspaceUri("src/b.ts")]
    expect(client?.initializeCalled).toBe(true)
    expect(client?.openFiles).toEqual(uris)
    expect(client?.closedFiles).toEqual(uris)
    expect(client?.shutdownCount).toBe(1)
  })

  it("opens each file of the ts language under the LSP language id its extension names", async () => {
    const opened: Record<string, string> = {
      "src/a.ts": "typescript",
      "src/b.mts": "typescript",
      "src/c.cts": "typescript",
      "src/d.tsx": "typescriptreact",
      "src/e.js": "javascript",
      "src/f.mjs": "javascript",
      "src/g.cjs": "javascript",
      "src/h.jsx": "javascriptreact",
      "src/I.TSX": "typescriptreact",
      "src/a.d": "typescript",
      "src/.tsx": "typescript",
      "src/x.tsx/readme": "typescript",
    }
    const files = Object.keys(opened)
    const factory = mockServerFactory()

    await enrich({
      symbols: files.map((file) => makeClassSymbol(file, "C", 1)),
      fileContents: Object.fromEntries(files.map((file) => [file, "class C {}"])),
      serverFactory: factory,
    })

    const client = factory.clients.get("ts")
    expect(
      Object.fromEntries(
        (client?.openFiles ?? []).map((uri, i) => [uri, client?.openLanguageIds[i]]),
      ),
    ).toEqual(Object.fromEntries(files.map((file) => [workspaceUri(file), opened[file]])))
  })

  it.each(["go", "py"])("opens a %s file under its own language id", async (language) => {
    const factory = mockServerFactory()

    await enrich({
      symbols: [
        makeSymbol(`${language}:src/a.${language}#f`, { language: makeLanguageId(language) }),
      ],
      fileContents: { [`src/a.${language}`]: "" },
      serverFactory: factory,
      lspConfig: makeLspConfig({ servers: { [language]: makeServerConfig() } }),
    })

    expect(factory.clients.get(language)?.openLanguageIds).toEqual([language])
  })

  it("opens the file by the name on disk, not by the Document's spelling of it", async () => {
    const documentPath = "src/caf\u00e9.ts"
    const onDisk = "src/caf\u0065\u0301.ts"
    const factory = mockServerFactory()

    await enrich({
      symbols: [makeClassSymbol(documentPath, "C", 1)],
      fileContents: { [documentPath]: "class C {}" },
      fsPaths: { [documentPath]: onDisk },
      serverFactory: factory,
    })

    expect(factory.clients.get("ts")?.openFiles).toEqual([workspaceUri(onDisk)])
  })

  it.each<[string, (client: MockLspClient) => void]>([
    [
      "reports a failure",
      (client) =>
        client.installInitializeFailure({
          kind: "error",
          reason: "server-error",
          message: "no capabilities",
        } satisfies LspFailure),
    ],
    ["throws", (client) => client.installInitializeThrow(new Error("no capabilities"))],
  ])("disables the language and still shuts the server down when initialize %s", async (_, setup) => {
    const factory = mockServerFactory(setup)
    const logger = recordingLogger()

    const result = await enrich({
      symbols: [makeClassSymbol("src/a.ts", "C", 1)],
      fileContents: { "src/a.ts": "class C {}" },
      serverFactory: factory,
      logger,
    })

    expect(result.stats?.languagesDisabled).toEqual(["ts"])
    expect(factory.clients.get("ts")?.openFiles).toEqual([])
    expect(factory.clients.get("ts")?.shutdownCount).toBe(1)
    expect(logger.warnings).toEqual([expect.stringContaining("no capabilities")])
  })

  it.each<[string, (client: MockLspClient) => void, string]>([
    [
      "fails",
      (client) => client.installShutdownThrow(new Error("pipe already closed")),
      "pipe already closed",
    ],
    ["never answers", (client) => client.installShutdownHang(), "no answer in"],
  ])("warns that a server whose shutdown %s may still be running, and keeps its enrichment", async (_, setup, detail) => {
    const logger = recordingLogger()

    const result = await enrich({
      symbols: [makeClassSymbol("src/a.ts", "C", 1)],
      fileContents: { "src/a.ts": "class C {}" },
      serverFactory: mockServerFactory((client) => {
        client.installHandler(DOC_SYMBOL_METHOD, () => [docSymbol("C", 1, 6)])
        setup(client)
      }),
      logger,
    })

    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain("may still be running")
    expect(logger.warnings[0]).toContain(detail)
    expect(result.symbols[0]?.source.startColumn).toBe(7)
    expect(result.stats?.languagesDisabled).toEqual([])
  })
})

describe("an lsp.servers key no loaded language plugin has", () => {
  async function warningsFor(
    servers: string[],
    languageIds: readonly string[] | undefined,
  ): Promise<string[]> {
    const logger = recordingLogger()
    await enrich({
      symbols: [],
      fileContents: {},
      serverFactory: mockServerFactory(),
      lspConfig: makeLspConfig({
        servers: Object.fromEntries(servers.map((key) => [key, makeServerConfig()])),
      }),
      logger,
      ...(languageIds === undefined ? {} : { languageIds: languageIds.map(makeLanguageId) }),
    })
    return logger.warnings
  }

  it("is warned about, each such key once and in key order", async () => {
    expect(await warningsFor(["typescript", "ts", "python"], ["ts"])).toEqual([
      "[aburi:lsp] lsp.servers.python matches no loaded language plugin (loaded: ts); its server is never started",
      "[aburi:lsp] lsp.servers.typescript matches no loaded language plugin (loaded: ts); its server is never started",
    ])
  })

  it("is warned about with none loaded when the run loaded no plugin", async () => {
    expect(await warningsFor(["ts"], [])).toEqual([
      "[aburi:lsp] lsp.servers.ts matches no loaded language plugin (loaded: none); its server is never started",
    ])
  })

  it.each<[string, string[], string[] | undefined]>([
    ["every key is loaded", ["ts"], ["ts"]],
    ["the caller does not say what is loaded", ["typescript"], undefined],
  ])("is not warned about when %s", async (_, servers, languageIds) => {
    expect(await warningsFor(servers, languageIds)).toEqual([])
  })
})
