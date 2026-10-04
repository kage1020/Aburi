import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { fixtureRoot, useFixtureCheckout } from "../src/fixture"
import { scanWith, symbolById } from "../src/scan-helper"

/**
 * The LSP pass against what typescript-language-server actually sends. The answers in
 * `fixtures/lsp-recorded.answers.json` were recorded from that server on the
 * `lsp-recorded` fixture, and are replayed here byte for byte: a hover at a position the
 * recording has no answer for gets `null`, so a pass that asks somewhere else gets nothing.
 */
interface RecordedAnswers {
  documentSymbol: Record<string, unknown>
  hover: Record<string, unknown>
}

const answers = JSON.parse(
  readFileSync(fixtureRoot("lsp-recorded.answers.json"), "utf8"),
) as RecordedAnswers

const fixture = useFixtureCheckout("lsp-recorded", "all")

const config: Config = {
  lsp: {
    enabled: true,
    servers: {
      ts: {
        command: "recorded-typescript-language-server",
        args: [],
        initializeTimeoutMs: 1000,
        requestTimeoutMs: 100,
        fileBudgetMs: 500,
        concurrency: 4,
        initializationOptions: {},
      },
    },
  },
}

function replayingFactory(root: string): ServerFactory {
  const prefix = `${pathToFileURL(root).href}/`
  const relative = (uri: string) => (uri.startsWith(prefix) ? uri.slice(prefix.length) : uri)
  return (): LspClient => ({
    async initialize() {
      return { capabilities: {} }
    },
    async didOpen() {
      return null
    },
    async didClose() {
      return null
    },
    async request<T>(method: string, params: unknown): Promise<T | LspFailure> {
      const { textDocument, position } = params as {
        textDocument: { uri: string }
        position?: { line: number; character: number }
      }
      const file = relative(textDocument.uri)
      if (method === "textDocument/documentSymbol") {
        return (answers.documentSymbol[file] ?? []) as T
      }
      if (method === "textDocument/hover" && position !== undefined) {
        return (answers.hover[`${file}:${position.line}:${position.character}`] ?? null) as T
      }
      return null as T
    },
    async shutdown() {},
  })
}

async function scanRecorded() {
  return scanWith(fixture.root, { languages: [langTypescriptPlugin] }, config, {
    lspServerFactory: replayingFactory(fixture.root),
  })
}

describe("LSP pass against recorded typescript-language-server answers", () => {
  it("reads @throws as the server renders it into inferredThrows", async () => {
    const result = await scanRecorded()
    const run = symbolById(result, "ts:src/repo.ts#Repo.run")
    // The braced type and the bare one. `@throws TypeError when …` is a description, which
    // names nothing (ir-schema.md §7).
    expect(run.signature?.inferredThrows).toEqual(["NotFoundError", "RangeError"])
    expect(run.signature?.throws).toEqual([])
  })

  it("resolves this. calls in a generic class and in a static method", async () => {
    const result = await scanRecorded()
    const store = symbolById(result, "ts:src/repo.ts#Store.run")
    expect(store.calls.map((call) => call.resolved)).toEqual([
      "ts:src/repo.ts#Store.count",
      "ts:src/repo.ts#Store.count",
    ])
    const build = symbolById(result, "ts:src/repo.ts#Factory::build")
    expect(build.calls.map((call) => call.resolved)).toEqual(["ts:src/repo.ts#Factory::create"])
    const lsp = result.ir.stats.lspEnrichment
    // `Repo.run`, both `this.count()` calls (each read on its own), and `Factory::build`.
    expect(lsp?.hintsProduced).toBe(4)
    expect(lsp?.hintsRejected).toEqual({
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 0,
      kindMismatch: 0,
      targetDropped: 0,
    })
  })

  it("gives decorated declarations and the default export their columns", async () => {
    const result = await scanRecorded()
    const columns = (id: string) => {
      const { startLine, startColumn, endLine, endColumn } = symbolById(result, id).source
      return { startLine, startColumn, endLine, endColumn }
    }
    expect(columns("ts:src/api.ts#Api")).toEqual({
      startLine: 4,
      startColumn: 1,
      endLine: 12,
      endColumn: 2,
    })
    expect(columns("ts:src/api.ts#Api.list")).toEqual({
      startLine: 6,
      startColumn: 3,
      endLine: 8,
      endColumn: 4,
    })
    expect(columns("ts:src/api.ts#Api.one")).toEqual({
      startLine: 9,
      startColumn: 3,
      endLine: 11,
      endColumn: 4,
    })
    expect(columns("ts:src/api.ts#<default>")).toEqual({
      startLine: 13,
      startColumn: 1,
      endLine: 15,
      endColumn: 2,
    })
  })
})
