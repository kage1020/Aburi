import { sig } from "@aburi/test-support"
import type { ImportEdge, Symbol as IRSymbol, Signature } from "@aburi/types"
import { makeSymbol, type SymbolOverrides } from "./ir"

export function withCalls(
  id: string,
  calls: ReadonlyArray<{ target: string; line: number }>,
  overrides: SymbolOverrides = {},
): IRSymbol {
  return makeSymbol(id, {
    calls: calls.map((call) => ({ ...call, resolved: null })),
    ...overrides,
  })
}

export type ImportClause = Partial<ImportEdge> & Pick<ImportEdge, "source">

export function importEdge(clause: ImportClause): ImportEdge {
  return { symbols: [], line: 1, dynamic: false, ...clause }
}

export function importsOf(
  file: string,
  ...edges: ImportClause[]
): Map<string, readonly ImportEdge[]> {
  return new Map([[file, edges.map(importEdge)]])
}

export function params(...names: string[]): Signature {
  return sig({ inputs: names.map((name) => ({ name, type: "unknown" })) })
}
