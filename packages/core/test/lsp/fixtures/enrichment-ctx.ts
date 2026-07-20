import type { Config, Symbol as IRSymbol, LspServerConfig } from "@aburi/types"
import type { EnrichmentInput, ServerFactory } from "../../../src/lsp"
import { makeSymbol } from "../../fixtures/ir"

export const TEST_WORKSPACE_ROOT = "/workspace"

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

export function makeEnrichmentInput(input: {
  symbols: IRSymbol[]
  fileContents: Record<string, string>
  serverFactory: ServerFactory
  lspConfig?: Config["lsp"]
}): EnrichmentInput {
  const base: EnrichmentInput = {
    symbols: input.symbols,
    workspaceRoot: TEST_WORKSPACE_ROOT,
    fileContents: new Map(Object.entries(input.fileContents)),
    lspConfig: input.lspConfig ?? makeLspConfig(),
    serverFactory: input.serverFactory,
  }
  return base
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
    name: `${className}.${methodName}`,
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
    name: className,
    source: { file, startLine: line, endLine: line, startColumn: null, endColumn: null },
  })
}
