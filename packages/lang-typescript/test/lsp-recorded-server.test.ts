import { pathToFileURL } from "node:url"
import type { LspClient, LspFailure, ServerFactory } from "@aburi/core"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import type { Config, LspServerConfig } from "@aburi/types"
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
    "function Get(_p: string | { path: string }): MethodDecorator { return () => {} }",
    '@Controller("x")',
    "export class Api {",
    '  @Get("a")',
    "  list(): number {",
    "    return 1",
    "  }",
    "  one(): number {",
    "    return 2",
    "  }",
    "  @Get({",
    '    path: "b",',
    "  }) find(): number {",
    "    return 3",
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
    "  /**",
    "   * @throws {NotFoundError} when the row",
    "   *   is missing",
    "   * @throws {@link RangeError} if negative",
    "   * @throws {@linkcode TypeError}",
    "   * @throws SyntaxError",
    "   *   on a wrapped line",
    "   */",
    "  find(id: number): number {",
    "    return id",
    "  }",
    "  seek(): number {",
    "    return this.find(1)",
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
    "  static {",
    "    this.create()",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/kinds.ts": [
    "function debounce<A extends unknown[]>(fn: (...args: A) => void, _ms: number): (...args: A) => void {",
    "  return fn",
    "}",
    "function makeFn(): () => string {",
    '  return () => ""',
    "}",
    "export class Pool {",
    "  size(): number { return 1 }",
    "  static size(): number { return 2 }",
    "  static {",
    "    this.size()",
    "  }",
    "  static total(): number {",
    "    return this.size()",
    "  }",
    "  count(): number {",
    "    return this.size()",
    "  }",
    "}",
    "export class Search {",
    "  static search(q: string): string { return q.trim() }",
    "  search = debounce((_q: string) => {}, 300)",
    '  static run(): string { return "" }',
    "  run: () => string = makeFn()",
    '  static load(): string { return "" }',
    "  load!: () => string",
    "  onInput(): void {",
    '    this.search("x")',
    "    this.run()",
    "    this.load()",
    "  }",
    "}",
    "",
  ].join("\n"),
}

const answers: {
  documentSymbol: Record<string, unknown>
  hover: Record<string, unknown>
} = recorded

function lspConfig(server: Partial<LspServerConfig>): Config {
  return {
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
          ...server,
        },
      },
    },
  }
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

async function writeProject() {
  for (const [path, content] of Object.entries(PROJECT)) await workspace.writeSource(path, content)
}

async function scanRecorded() {
  await writeProject()
  return scanTypeScript(workspace.root, lspConfig({}), {
    lspServerFactory: replayingFactory(workspace.root),
  })
}

describe("the LSP pass against recorded typescript-language-server answers", () => {
  it("reads @throws as the server renders it into inferredThrows", async () => {
    const result = await scanRecorded()

    const run = symbolById(result, "ts:src/repo.ts#Repo.run")
    expect(run.signature?.inferredThrows).toEqual(["NotFoundError", "RangeError"])
    expect(run.signature?.throws).toEqual([])
    const seek = symbolById(result, "ts:src/repo.ts#Repo.seek")
    expect(seek.signature?.inferredThrows).toEqual(["NotFoundError", "RangeError", "TypeError"])
    expect(seek.signature?.inferredThrows).toEqual(
      symbolById(result, "ts:src/repo.ts#Repo.find").signature?.throws.toSorted(),
    )
  })

  it("resolves this. calls to a member of the caller's own kind", async () => {
    const result = await scanRecorded()
    const resolved = (id: string) => symbolById(result, id).calls.map((c) => c.resolved)

    expect({
      "Store.run": resolved("ts:src/repo.ts#Store.run"),
      "Factory::build": resolved("ts:src/repo.ts#Factory::build"),
      Factory: resolved("ts:src/repo.ts#Factory"),
      "Pool::total": resolved("ts:src/kinds.ts#Pool::total"),
      "Pool.count": resolved("ts:src/kinds.ts#Pool.count"),
      Pool: resolved("ts:src/kinds.ts#Pool"),
      "Search.onInput": resolved("ts:src/kinds.ts#Search.onInput"),
    }).toEqual({
      "Store.run": ["ts:src/repo.ts#Store.count", "ts:src/repo.ts#Store.count"],
      "Factory::build": ["ts:src/repo.ts#Factory::create"],
      Factory: ["ts:src/repo.ts#Factory::create"],
      "Pool::total": ["ts:src/kinds.ts#Pool::size"],
      "Pool.count": ["ts:src/kinds.ts#Pool.size"],
      Pool: [null],
      "Search.onInput": [null, null, null],
    })
    expect(result.ir.stats.lspEnrichment?.hintsProduced).toBe(8)
    expect(result.ir.stats.lspEnrichment?.hintsRejected).toEqual({
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 4,
      kindMismatch: 0,
      targetDropped: 0,
    })
  })

  it("gives decorated declarations and a default export their columns", async () => {
    const result = await scanRecorded()
    const columns = (id: string) => {
      const { startLine, startColumn, endLine, endColumn } = symbolById(result, id).source
      return { startLine, startColumn, endLine, endColumn }
    }

    expect({
      Api: columns("ts:src/api.ts#Api"),
      "Api.list": columns("ts:src/api.ts#Api.list"),
      "Api.one": columns("ts:src/api.ts#Api.one"),
      "Api.find": columns("ts:src/api.ts#Api.find"),
      "<default>": columns("ts:src/api.ts#<default>"),
    }).toEqual({
      Api: { startLine: 4, startColumn: 1, endLine: 17, endColumn: 2 },
      "Api.list": { startLine: 6, startColumn: 3, endLine: 8, endColumn: 4 },
      "Api.one": { startLine: 9, startColumn: 3, endLine: 11, endColumn: 4 },
      "Api.find": { startLine: 14, startColumn: 6, endLine: 16, endColumn: 4 },
      "<default>": { startLine: 18, startColumn: 1, endLine: 20, endColumn: 2 },
    })
  })
})

// A typescript-language-server binary, such as core's devDependency, to check the answers against.
const liveServer = process.env.ABURI_LIVE_TS_LANGUAGE_SERVER

describe.runIf(liveServer !== undefined)("the recorded answers against a live server", () => {
  it("give the IR the live server's own answers give", async () => {
    const replayed = await scanRecorded()
    const live = await scanTypeScript(
      workspace.root,
      lspConfig({
        command: liveServer ?? "",
        args: ["--stdio"],
        initializeTimeoutMs: 60_000,
        requestTimeoutMs: 30_000,
        fileBudgetMs: 120_000,
      }),
    )

    expect(live.ir).toEqual(replayed.ir)
  }, 180_000)
})
