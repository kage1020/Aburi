import type { IR, Symbol as IRSymbol } from "@aburi/types"

const SCHEMA = "https://aburi.dev/schema/aburi.ir.v1.json"

export function minimalIR(): IR {
  return {
    $schema: SCHEMA,
    generator: {
      name: "aburi",
      version: "0.0.0",
      plugins: [],
    },
    workspace: {
      root: ".",
      managers: [],
      languages: ["ts"],
    },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
    },
  }
}

export function makeSymbol(id: string, overrides: Partial<IRSymbol> = {}): IRSymbol {
  return {
    id,
    kind: "function",
    extKind: null,
    name: id.split("#")[1] ?? "anonymous",
    language: "ts",
    component: null,
    visibility: "public",
    decorators: [],
    signature: null,
    rules: [],
    effects: [],
    calls: [],
    source: {
      file: id.split(":")[1]?.split("#")[0] ?? "src/a.ts",
      startLine: 1,
      endLine: 1,
      startColumn: null,
      endColumn: null,
    },
    fingerprint: { api: "0".repeat(12), logic: "0".repeat(12), syntax: "0".repeat(12) },
    confidence: "high",
    derivedBy: [],
    dropped: false,
    dropReason: null,
    ...overrides,
  }
}
