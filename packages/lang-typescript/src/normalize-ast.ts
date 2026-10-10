import type { MergedDeclaration, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"

export function normalizeAst(symbol: SymbolCandidate<Node>): string {
  if (symbol.kind === "call") return serialize(symbol.fullNode)
  const described: { node: Node; fullNode: Node }[] = []
  for (const declaration of [symbol, ...(symbol.mergedDeclarations ?? [])]) {
    const node = describedNode(declaration)
    if (described.some((seen) => seen.node.id === node.id)) continue
    described.push({ node, fullNode: declaration.fullNode })
  }
  return described
    .flatMap(({ node, fullNode }) => [serialize(node), classHead(fullNode)])
    .filter((part) => part.length > 0)
    .join(" ")
}

function classHead(fullNode: Node): string {
  if (!CLASS_TYPES.has(fullNode.type)) return ""
  const parts: string[] = []
  if (fullNode.type === "abstract_class_declaration") parts.push(JSON.stringify("abstract"))
  for (const child of fullNode.namedChildren) {
    if (child === null) continue
    if (child.type === "type_parameters" || child.type === "class_heritage") {
      parts.push(serialize(child))
    }
  }
  return parts.join(" ")
}

const CLASS_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
])

function describedNode(declaration: Pick<MergedDeclaration<Node>, "bodyNode" | "fullNode">): Node {
  const { bodyNode, fullNode } = declaration
  return bodyNode !== null && bodyNode.parent?.id === fullNode.id ? bodyNode : fullNode
}

function serialize(node: Node): string {
  if (node.isExtra) return ""
  if (SKIPPED_NODE_TYPES.has(node.type)) return ""

  const children: string[] = []
  let previous: Node | null = null
  for (const child of node.children) {
    if (child.isMissing) continue
    const rendered = child.isNamed ? serialize(child) : tokenPayload(child, previous, node)
    if (rendered.length > 0) children.push(rendered)
    if (!child.isExtra) previous = child
  }

  const leafText = leafPayload(node)
  if (children.length === 0 && leafText === null) return `(${node.type})`
  if (children.length === 0 && leafText !== null) return `(${node.type} ${leafText})`
  return `(${node.type} ${children.join(" ")})`
}

function tokenPayload(token: Node, previous: Node | null, parent: Node): string {
  if (token.isExtra) return ""
  if (isElision(token, previous, parent)) return JSON.stringify(token.type)
  if (FORMATTING_TOKENS.has(token.type)) return ""
  return JSON.stringify(token.type)
}

function isElision(token: Node, previous: Node | null, parent: Node): boolean {
  if (token.type !== "," || !ELIDING_TYPES.has(parent.type)) return false
  return previous?.type === "[" || previous?.type === ","
}

const ELIDING_TYPES: ReadonlySet<string> = new Set(["array", "array_pattern"])

const FORMATTING_TOKENS: ReadonlySet<string> = new Set([
  ";",
  ",",
  '"',
  "'",
  "`",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
])

/** Node types that never contribute to the normalized AST. */
const SKIPPED_NODE_TYPES: ReadonlySet<string> = new Set(["comment", "hash_bang_line"])

const LEAF_TEXT_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "private_property_identifier",
  "number",
  "string_fragment",
  "regex_pattern",
  "regex_flags",
  "escape_sequence",
  "template_chars",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "super",
])

function leafPayload(node: Node): string | null {
  if (!LEAF_TEXT_TYPES.has(node.type)) return null
  const text = node.text
  if (text.length === 0) return null
  return JSON.stringify(text)
}
