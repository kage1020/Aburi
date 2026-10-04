import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../../src/id"
import { enrichWithLsp } from "../../src/lsp"
import { makeSymbol } from "../fixtures/ir"
import { capturingLogger } from "../fixtures/plugins"
import {
  makeClassSymbol,
  makeEnrichmentInput,
  makeLspConfig,
  makeServerConfig,
} from "./fixtures/enrichment-ctx"
import { type MockLspClient, mockServerFactory } from "./fixtures/mock-server"

const TS = makeLanguageId("ts")

async function openedLanguageIds(files: string[]): Promise<Record<string, string>> {
  const clients: MockLspClient[] = []
  const factory = mockServerFactory((_lang, client) => {
    client.installHandler("textDocument/documentSymbol", () => [])
    clients.push(client)
  })
  await enrichWithLsp(
    makeEnrichmentInput({
      symbols: files.map((file) => makeClassSymbol(file, "C", 1)),
      fileContents: Object.fromEntries(files.map((file) => [file, "class C {}"])),
      serverFactory: factory,
    }),
  )
  const client = clients[0]
  if (client === undefined) throw new Error("no server was started")
  return Object.fromEntries(
    client.openFiles.map((uri, i) => [
      uri.slice(uri.lastIndexOf("/") + 1),
      client.openLanguageIds[i] ?? "<none>",
    ]),
  )
}

describe("LSP didOpen languageId", () => {
  it("opens each file of the ts language under the LSP id its extension names", async () => {
    expect(
      await openedLanguageIds([
        "src/a.ts",
        "src/b.mts",
        "src/c.cts",
        "src/d.tsx",
        "src/e.js",
        "src/f.mjs",
        "src/g.cjs",
        "src/h.jsx",
        "src/I.TSX",
      ]),
    ).toEqual({
      "a.ts": "typescript",
      "b.mts": "typescript",
      "c.cts": "typescript",
      "d.tsx": "typescriptreact",
      "e.js": "javascript",
      "f.mjs": "javascript",
      "g.cjs": "javascript",
      "h.jsx": "javascriptreact",
      "I.TSX": "typescriptreact",
    })
  })

  it("falls back to typescript for a ts file whose extension names no LSP language", async () => {
    expect(await openedLanguageIds(["src/a.d", "src/.tsx", "src/x.tsx/readme"])).toEqual({
      "a.d": "typescript",
      ".tsx": "typescript",
      readme: "typescript",
    })
  })
})

describe("LSP didOpen languageId outside the ts language", () => {
  it("opens a file of another language under that language's own id", async () => {
    const opened: string[] = []
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler("textDocument/documentSymbol", () => [])
      client.didOpen = async (_uri, languageId) => {
        opened.push(languageId)
        return null
      }
    })
    await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [
          makeSymbol("py:src/b.py#beta", {
            language: makeLanguageId("py"),
            name: "beta",
            source: {
              file: "src/b.py",
              startLine: 1,
              endLine: 1,
              startColumn: null,
              endColumn: null,
            },
          }),
        ],
        fileContents: { "src/b.py": "def beta(): pass\n" },
        serverFactory: factory,
        lspConfig: makeLspConfig({ servers: { py: makeServerConfig() } }),
      }),
    )
    expect(opened).toEqual(["py"])
  })
})

describe("LSP server keys", () => {
  async function warningsFor(
    servers: string[],
    languageIds: readonly string[] | undefined,
  ): Promise<string[]> {
    const { logger, warnings } = capturingLogger()
    const input = makeEnrichmentInput({
      symbols: [],
      fileContents: {},
      serverFactory: mockServerFactory(() => {}),
      lspConfig: makeLspConfig({
        servers: Object.fromEntries(servers.map((key) => [key, makeServerConfig()])),
      }),
      logger,
      ...(languageIds === undefined ? {} : { languageIds: languageIds.map(makeLanguageId) }),
    })
    await enrichWithLsp(input)
    return warnings
  }

  it("warns about each key that names no loaded language plugin", async () => {
    const warnings = await warningsFor(["typescript", "ts", "python"], [TS])
    expect(warnings).toEqual([
      "[aburi:lsp] lsp.servers.python matches no loaded language plugin (loaded: ts); its server is never started",
      "[aburi:lsp] lsp.servers.typescript matches no loaded language plugin (loaded: ts); its server is never started",
    ])
  })

  it("says none were loaded when the run loaded no plugin", async () => {
    expect(await warningsFor(["ts"], [])).toEqual([
      "[aburi:lsp] lsp.servers.ts matches no loaded language plugin (loaded: none); its server is never started",
    ])
  })

  it("stays quiet when every key is loaded, or when the caller does not say what is", async () => {
    expect(await warningsFor(["ts"], [TS])).toEqual([])
    expect(await warningsFor(["typescript"], undefined)).toEqual([])
  })
})
