import type { DropHint, ExtractionContext, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { bodyNodesOf, functionValueOf } from "./ast-helpers"

export const TYPESCRIPT_FILE_DROP_PATTERNS: readonly string[] = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
]

export function classifySymbolDropHint(
  symbol: SymbolCandidate<Node>,
  _ctx: ExtractionContext,
): DropHint | null {
  if (symbol.decorators.some((d) => d.boundary)) return null
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

function classifyClassBody(symbol: SymbolCandidate<Node>): DropHint | null {
  const bodies = bodyNodesOf(symbol).filter((body) => body.type === "class_body")
  if (bodies.length === 0) return null

  let hasMethod = false
  let allStaticLiteral = true
  let hasAnyField = false
  for (const member of bodies.flatMap((body) => body.namedChildren)) {
    if (member === null) continue
    switch (member.type) {
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature":
        hasMethod = true
        allStaticLiteral = false
        break
      case "public_field_definition":
        if (functionValueOf(member) !== null) {
          hasMethod = true
          allStaticLiteral = false
          break
        }
        hasAnyField = true
        if (!isConstantLikeField(member)) allStaticLiteral = false
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

/** A field that is `static` **or** `readonly` and holds a literal — what "pure constants" counts. */
function isConstantLikeField(field: Node): boolean {
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

function classifyFunctionBody(symbol: SymbolCandidate<Node>): DropHint | null {
  const bodies = bodyNodesOf(symbol).filter(
    (body) => body.type === "statement_block" || body.type === "class_body",
  )
  if (bodies.length === 0) return null
  const hasStatement = bodies.some((body) =>
    body.namedChildren.some(
      (c) => c !== null && c.type !== "comment" && c.type !== "hash_bang_line",
    ),
  )
  if (!hasStatement) return { reason: "empty body", category: "B" }
  return null
}
