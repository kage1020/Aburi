import type { OpaqueAstNode, SymbolCandidate } from "@aburi/types"

/**
 * Category B — Symbol-level drop decisions per drop-list.md §4. Returned as either a
 * `dropReason` string (the caller stamps `dropped: true` + the reason on the emitted
 * Symbol) or `null` when the Symbol is not a drop candidate.
 *
 * The rules covered by core here are the "shape-only" ones — patterns that any
 * language plugin's SymbolCandidate can be checked against without extra language
 * knowledge. Language-specific rules ride on `LanguagePlugin.symbolDropHint` which the
 * caller layers on top of this result.
 */
export function decideSymbolDrop(symbol: SymbolCandidate<OpaqueAstNode>): string | null {
  // A boundary decorator overrides every core drop rule below (drop-list.md §4.1
  // second paragraph on boundary decorators) — a framework plugin has already declared
  // the Symbol to be part of the observable surface, so removing it from the IR would
  // lose the wire.
  if (symbol.decorators.some((d) => d.boundary)) return null

  if (symbol.kind === "interface") return "interface (data model)"
  if (symbol.kind === "type") return "type alias"

  // Empty function / method bodies are ceremonial — abstract stubs, no-op adapters,
  // decorator markers. No body node at all means the language plugin flagged the Symbol as
  // body-less; a further check would need AST knowledge and belongs in `symbolDropHint`.
  // A merged declaration counts, because a Symbol several declarations wrote is body-less
  // only when none of them gave it one.
  if ((symbol.kind === "function" || symbol.kind === "method") && !hasAnyBody(symbol)) {
    return "empty body"
  }

  // Re-export detection: `derivedBy` carries `"re-export"` when the language plugin
  // resolved the Symbol to a re-exported binding. Non-re-export bindings do not
  // include the tag.
  if (symbol.derivedBy.includes("re-export")) return "re-export"

  return null
}

function hasAnyBody(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.bodyNode !== null) return true
  const merged = symbol.mergedDeclarations ?? []
  return merged.some((declaration) => declaration.bodyNode !== null)
}
