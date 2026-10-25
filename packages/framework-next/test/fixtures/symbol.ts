import { makeCandidate } from "@aburi/test-support"
import type { SymbolCandidate, SymbolKind } from "@aburi/types"

export { makeExtractionCtx as makeCtx } from "@aburi/test-support"

export interface SymbolShape {
  kind?: SymbolKind
  derivedBy?: string[]
}

/** A Symbol named `name` in `file`, a function unless `kind` says otherwise. */
export function symbolIn(
  file: string,
  name: string,
  { kind = "function", derivedBy = [] }: SymbolShape = {},
): SymbolCandidate<unknown> {
  return makeCandidate({
    kind,
    name,
    id: `ts:${file}#${name}`,
    source: { file, startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    derivedBy,
  })
}
