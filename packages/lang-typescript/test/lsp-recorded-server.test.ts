import { pathToFileURL } from "node:url"
import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import recorded from "./fixtures/lsp-recorded.answers.json" with { type: "json" }
import { scanTypeScript } from "./fixtures/scan"

// typescript-language-server answered at these positions in exactly these files, so they are
// written byte for byte; a hover anywhere else gets `null`.
const PROJECT: Record<string, string> = {
  "package.json":
    '{\n  "name": "lsp-recorded-fixture",\n  "version": "0.0.0",\n  "private": true,\n  "type": "module"\n}\n',
  "tsconfig.json":
    '{"compilerOptions":{"experimentalDecorators":true,"strict":true,"target":"es2022"}}\n',
  "src/api.ts": [
    "function Controller(_p: string): ClassDecorator { return () => {} }",
    "function Get(_p: string): MethodDecorator { return () => {} }",
    '@Controller("x")',
    "export class Api {",
    '  @Get("a")',
    "  list(): number {",
    "    return 1",
    "  }",
    "  one(): number {",
    "    return 2",
    "  }",
    "}",
    "export default function () {",
    "  return 3",
    "}",
    "",
  ].join("\n"),
  "src/repo.ts": [
    "export class NotFoundError extends Error {}",
    "export class Repo {",
    "  /**",
    "   * Loads a row.",
    "   * @throws {NotFoundError} when the row is missing",
    "   * @throws RangeError",
    "   * @throws TypeError when id is not an integer",
    "   */",
    "  load(id: number): number {",
    '    if (id < 0) throw new RangeError("neg")',
    '    if (!Number.isInteger(id)) throw new TypeError("int")',
    '    if (id > 100) throw new NotFoundError("x")',
    "    return id",
    "  }",
    "  run(): number {",
    "    return this.load(1)",
    "  }",
    "}",
    "export class Store<T> {",
    "  items: T[] = []",
    "  count(): number { return this.items.length }",
    "  run(): number {",
    "    return this.count() + this.count()",
    "  }",
    "}",
    "export class Factory {",
    "  static create(): Factory { return new Factory() }",
    "  static build(): Factory {",
    "    return this.create()",
    "  }",
    "}",
    "",
  ].join("\n"),
}

const answers: {
  documentSymbol: Record<string, unknown>
  hover: Record<string, unknown>
} = recorded

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

const workspace = useScratchWorkspace("lsp-recorded")

async function scanRecorded() {
  for (const [path, content] of Object.entries(PROJECT)) await workspace.writeSource(path, content)
  return scanTypeScript(workspace.root, config, {
    lspServerFactory: replayingFactory(workspace.root),
  })
}

describe("the LSP pass against recorded typescript-language-server answers", () => {
  it("reads @throws as the server renders it into inferredThrows", async () => {
    const run = symbolById(await scanRecorded(), "ts:src/repo.ts#Repo.run")

    expect(run.signature?.inferredThrows).toEqual(["NotFoundError", "RangeError"])
    expect(run.signature?.throws).toEqual([])
  })

  it("resolves this. calls in a generic class and in a static method", async () => {
    const result = await scanRecorded()

    expect(symbolById(result, "ts:src/repo.ts#Store.run").calls.map((c) => c.resolved)).toEqual([
      "ts:src/repo.ts#Store.count",
      "ts:src/repo.ts#Store.count",
    ])
    expect(
      symbolById(result, "ts:src/repo.ts#Factory::build").calls.map((c) => c.resolved),
    ).toEqual(["ts:src/repo.ts#Factory::create"])
    expect(result.ir.stats.lspEnrichment?.hintsProduced).toBe(4)
    expect(result.ir.stats.lspEnrichment?.hintsRejected).toEqual({
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 0,
      kindMismatch: 0,
      targetDropped: 0,
    })
  })

  it.each([
    ["ts:src/api.ts#Api", { startLine: 4, startColumn: 1, endLine: 12, endColumn: 2 }],
    ["ts:src/api.ts#Api.list", { startLine: 6, startColumn: 3, endLine: 8, endColumn: 4 }],
    ["ts:src/api.ts#Api.one", { startLine: 9, startColumn: 3, endLine: 11, endColumn: 4 }],
    ["ts:src/api.ts#<default>", { startLine: 13, startColumn: 1, endLine: 15, endColumn: 2 }],
  ])("gives %s its columns, decorated or a default export", async (id, expected) => {
    const { startLine, startColumn, endLine, endColumn } = symbolById(
      await scanRecorded(),
      id,
    ).source

    expect({ startLine, startColumn, endLine, endColumn }).toEqual(expected)
  })
})
