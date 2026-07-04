import type { SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Emit a positionless, comment-free S-expression for a SymbolCandidate's body.
 *
 * The output is the input to `syntaxFingerprint` in `@aburi/core`, so it must satisfy the
 * plugin contract there:
 *   - no comment nodes (we skip `comment` and `hash_bang_line` nodes)
 *   - no position information (byte offsets, rows, columns are all omitted)
 *   - no whitespace tokens (tree-sitter's `extra` nodes are dropped)
 *   - node kinds and child structure only
 *   - identifier and literal values ARE included — the syntax axis is sensitive to what
 *     the code says, not just how it is shaped
 *
 * When the SymbolCandidate has a `bodyNode`, that node is normalized (the class /
 * function body). When it does not (`type` / `interface` / bare `const`), the full node
 * is normalized instead so type aliases and interface shapes still get a stable hash.
 */
export function normalizeAst(symbol: SymbolCandidate<Node>): string {
  const target = symbol.bodyNode ?? symbol.fullNode
  return serialize(target)
}

function serialize(node: Node): string {
  if (node.isExtra) return ""
  if (SKIPPED_NODE_TYPES.has(node.type)) return ""

  const children: string[] = []
  for (const child of node.namedChildren) {
    if (child === null) continue
    const rendered = serialize(child)
    if (rendered.length > 0) children.push(rendered)
  }

  const leafText = leafPayload(node)
  if (children.length === 0 && leafText === null) return `(${node.type})`
  if (children.length === 0 && leafText !== null) return `(${node.type} ${leafText})`
  return `(${node.type} ${children.join(" ")})`
}

/** Node types that never contribute to the normalized AST. */
const SKIPPED_NODE_TYPES: ReadonlySet<string> = new Set(["comment", "hash_bang_line"])

/**
 * Leaf node types whose text (identifier, literal, keyword) should appear in the output.
 * The type IS the structure; the text IS the value the syntax axis needs to be sensitive
 * to.
 */
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
