import { pathToFileURL } from "node:url"
import type { Config, Symbol as IRSymbol, Logger, LspServerConfig } from "@aburi/types"
import {
  type EnrichmentInput,
  type EnrichmentResult,
  enrichWithLsp,
  type ServerFactory,
} from "../../../src/lsp"
import { makeSymbol } from "../../fixtures/ir"

const WORKSPACE_ROOT = "/workspace"

/** The URI a file at `fsPath` under the input's workspace root is opened by. */
export function workspaceUri(fsPath: string): string {
  return pathToFileURL(`${WORKSPACE_ROOT}/${fsPath}`).toString()
}

export function makeServerConfig(overrides: Partial<LspServerConfig> = {}): LspServerConfig {
  return {
    command: "mock-lsp-server",
    args: [],
    initializeTimeoutMs: 1000,
    requestTimeoutMs: 100,
    fileBudgetMs: 500,
    concurrency: 4,
    initializationOptions: {},
    ...overrides,
  }
}

export function makeLspConfig(overrides: Partial<NonNullable<Config["lsp"]>> = {}): Config["lsp"] {
  return {
    enabled: true,
    servers: { ts: makeServerConfig() },
    ...overrides,
  }
}

export function tsServer(overrides: Partial<LspServerConfig>): Config["lsp"] {
  return makeLspConfig({ servers: { ts: makeServerConfig(overrides) } })
}

export interface EnrichmentCase {
  symbols: IRSymbol[]
  fileContents: Record<string, string>
  serverFactory?: ServerFactory
  lspConfig?: Config["lsp"]
  now?: () => number
  fsPaths?: Record<string, string>
  logger?: Logger
}

export function makeEnrichmentInput(input: EnrichmentCase): EnrichmentInput {
  const { fileContents, fsPaths, lspConfig, ...rest } = input
  return {
    ...rest,
    workspaceRoot: WORKSPACE_ROOT,
    fileContents: new Map(
      Object.entries(fileContents).map(([path, content]) => [
        path,
        { content, fsPath: fsPaths?.[path] ?? path },
      ]),
    ),
    lspConfig: lspConfig ?? makeLspConfig(),
  }
}

export function enrich(input: EnrichmentCase): Promise<EnrichmentResult> {
  return enrichWithLsp(makeEnrichmentInput(input))
}

export function makeManualClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

export function makeMethodSymbol(
  file: string,
  className: string,
  methodName: string,
  line: number,
  calls: Array<{ target: string; line: number }> = [],
): IRSymbol {
  return makeSymbol(`ts:${file}#${className}.${methodName}`, {
    kind: "method",
    source: { file, startLine: line, endLine: line, startColumn: null, endColumn: null },
    calls: calls.map((c) => ({ ...c, resolved: null })),
    signature: {
      inputs: [],
      outputs: [],
      throws: [],
      async: false,
      generator: false,
      typeParameters: [],
    },
  })
}

export function makeClassSymbol(file: string, className: string, line: number): IRSymbol {
  return makeSymbol(`ts:${file}#${className}`, {
    kind: "class",
    source: { file, startLine: line, endLine: line, startColumn: null, endColumn: null },
  })
}

/** `class C { foo() {} bar() { this.foo() } }` in `src/a.ts`, with `bar` calling `this.foo` on line 4. */
export function thisFooFile(): Pick<EnrichmentCase, "symbols" | "fileContents"> {
  return {
    symbols: [
      makeClassSymbol("src/a.ts", "C", 1),
      makeMethodSymbol("src/a.ts", "C", "foo", 2),
      makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }]),
    ],
    fileContents: { "src/a.ts": "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}" },
  }
}

export const THIS_FOO_CALLER = "ts:src/a.ts#C.bar"
