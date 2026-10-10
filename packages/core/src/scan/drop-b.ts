import type { OpaqueAstNode, SymbolCandidate } from "@aburi/types"

export function decideSymbolDrop(symbol: SymbolCandidate<OpaqueAstNode>): string | null {
  if (symbol.decorators.some((d) => d.boundary)) return null

  if (symbol.kind === "interface") return "interface (data model)"
  if (symbol.kind === "type") return "type alias"

  if ((symbol.kind === "function" || symbol.kind === "method") && !hasAnyBody(symbol)) {
    return "empty body"
  }

  if (symbol.derivedBy.includes("re-export")) return "re-export"

  return null
}

function hasAnyBody(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.bodyNode !== null) return true
  const merged = symbol.mergedDeclarations ?? []
  return merged.some((declaration) => declaration.bodyNode !== null)
}
