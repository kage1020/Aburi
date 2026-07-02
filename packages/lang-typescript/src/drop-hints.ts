import type { DropHint, ExtractionContext, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Category-A skip patterns owned by this language plugin. Added on top of the core
 * standard set in drop-list.md §3.1. Config-level ignores stack on top of both.
 */
export const TYPESCRIPT_FILE_DROP_PATTERNS: readonly string[] = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
]

/**
 * Category-B hints for a SymbolCandidate. Returned as a hint, not a hard drop; the core
 * drop-list evaluator decides the final outcome after config.keep / config.suppress and
 * framework overrides are folded in.
 *
 * Covers the language-obvious cases the extractor is in a position to identify: interface,
 * type alias, empty function or method body, pure DTO (fields-only class without a
 * boundary decorator), and pure constants (static readonly literal fields only).
 * Re-exports are handled upstream by the import extractor rather than by this classifier;
 * everything else returns null and the Symbol flows through unchanged.
 */
export function classifySymbolDropHint(
  symbol: SymbolCandidate<Node>,
  _ctx: ExtractionContext,
): DropHint | null {
  switch (symbol.kind) {
    case "interface":
      return { reason: "interface (data model)", category: "B" }
    case "type":
      return { reason: "type alias", category: "B" }
    case "class":
      return classifyClassBody(symbol)
    case "method":
    case "function":
      return classifyFunctionBody(symbol)
    default:
      return null
  }
}

/**
 * A class Symbol whose body has nothing but field declarations (no methods, no boundary
 * decorators) is a DTO. A class with only static / readonly literal fields is treated as
 * pure constants.
 */
function classifyClassBody(symbol: SymbolCandidate<Node>): DropHint | null {
  const body = symbol.bodyNode
  if (body === null) return null
  const hasBoundary = symbol.decorators.some((d) => d.boundary)
  if (hasBoundary) return null

  let hasMethod = false
  let allStaticLiteral = true
  let hasAnyField = false
  for (const member of body.namedChildren) {
    if (member === null) continue
    switch (member.type) {
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature":
        hasMethod = true
        allStaticLiteral = false
        break
      case "public_field_definition":
      case "field_definition":
      case "property_signature":
        hasAnyField = true
        if (!isStaticLiteralField(member)) allStaticLiteral = false
        break
      default:
        allStaticLiteral = false
        break
    }
  }
  if (!hasMethod && !hasAnyField) return null
  if (!hasMethod && hasAnyField && allStaticLiteral) {
    return { reason: "pure constants", category: "B" }
  }
  if (!hasMethod) return { reason: "pure DTO", category: "B" }
  return null
}

function isStaticLiteralField(field: Node): boolean {
  let hasStatic = false
  let hasReadonly = false
  for (const child of field.children) {
    if (child === null) continue
    if (child.type === "static") hasStatic = true
    else if (child.type === "readonly") hasReadonly = true
  }
  if (!hasStatic && !hasReadonly) return false
  const value = field.childForFieldName("value")
  if (value === null) return false
  return isLiteralNode(value)
}

function isLiteralNode(node: Node): boolean {
  switch (node.type) {
    case "number":
    case "string":
    case "template_string":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "regex":
      return true
    default:
      return false
  }
}

/**
 * A function or method whose body is exactly `{}` is treated as empty. Bodies that
 * contain nothing but a return of a literal / identifier are not caught here — those
 * are legitimate stubs and users often mean them to survive.
 */
function classifyFunctionBody(symbol: SymbolCandidate<Node>): DropHint | null {
  const body = symbol.bodyNode
  if (body === null) return null
  if (body.type !== "statement_block" && body.type !== "class_body") return null
  const hasStatement = body.namedChildren.some(
    (c) => c !== null && c.type !== "comment" && c.type !== "hash_bang_line",
  )
  if (!hasStatement) return { reason: "empty body", category: "B" }
  return null
}
