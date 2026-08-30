import type { DropHint, ExtractionContext, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { bodyNodesOf } from "./ast-helpers"

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
  // A boundary decorator overrides every hint below, the way it overrides every core rule in
  // `decideSymbolDrop` — `drop-list.md` §4.1. The check has to be here as well as there:
  // `decideDropReason` asks core first, core answers `null` on a boundary, and then asks this.
  // So an unguarded arm here is the one that decides, and a `@Controller()` class merged into
  // an interface written above it was dropped as a data model.
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

/**
 * A class Symbol whose bodies have nothing but field declarations is a DTO. A class with only
 * static / readonly literal fields is treated as pure constants. Bodies, plural: a class
 * merged with a later `class C {}` contributes each of them, and a member found in any one of
 * them is a member the class has.
 */
function classifyClassBody(symbol: SymbolCandidate<Node>): DropHint | null {
  // Class bodies only. A `class C {}` merged with an `interface C {}` above it carries the
  // interface's `interface_body` too, and its `method_signature` members would read as
  // methods the class does not have — turning `pure constants` into `pure DTO`, and a DTO
  // into a Symbol that is not dropped at all.
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
  const bodies = bodyNodesOf(symbol).filter(
    (body) => body.type === "statement_block" || body.type === "class_body",
  )
  if (bodies.length === 0) return null
  // Every body, because one of them having something to say is enough: a property whose
  // getter is `{}` and whose setter validates is not ceremony.
  const hasStatement = bodies.some((body) =>
    body.namedChildren.some(
      (c) => c !== null && c.type !== "comment" && c.type !== "hash_bang_line",
    ),
  )
  if (!hasStatement) return { reason: "empty body", category: "B" }
  return null
}
