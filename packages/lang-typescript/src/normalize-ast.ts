import type { MergedDeclaration, SymbolCandidate } from "@aburi/types"
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
 * A declaration is described by its own body when it has one — a function's or a method's
 * `statement_block`, a class's `class_body`, an interface's `interface_body` — and by its full
 * node when it has none (a type alias, an enum, a namespace, a bare `const`), so those still get
 * a stable hash (`describedNode`).
 *
 * A Symbol whose declaration is a **call** is the exception, and is always described by its
 * full node. Its body is a function written inside that call, so narrowing to the body would
 * drop the registration itself: `app.get('/x', authenticate, h)` and `app.get('/x', h)` would
 * serialize identically, and adding or removing a route's auth middleware would produce no
 * signal on any axis. The body is what the registration *runs*, which is the walk's question;
 * the whole call is what it *is*, which is this one. A `const` initialised by a call that is
 * handed a function has the same shape and gets the same answer, through `describedNode`
 * rather than its kind, because such a const can also arrive as a merged declaration.
 *
 * A Symbol several declarations wrote — a getter beside its setter, an interface reopened —
 * gets each further declaration's description appended, in source order. Each declaration is
 * described once: a const that hands its call two functions has two bodies but one
 * declaration, and both bodies name it (`inlineHandlers`).
 *
 * So giving a const a body moved no existing fingerprint, for three reasons that each have to
 * keep holding: a Symbol with one declaration and its own body or none serializes exactly as it
 * did; a const that gained a body is described by the declaration that described it while it
 * had none; and a declaration is described once, so a second function adds no second copy.
 */
export function normalizeAst(symbol: SymbolCandidate<Node>): string {
  if (symbol.kind === "call") return serialize(symbol.fullNode)
  const merged = symbol.mergedDeclarations ?? []
  const lead = describedNode(symbol)
  if (merged.length === 0) return serialize(lead)
  const described = [lead]
  for (const declaration of merged) {
    const node = describedNode(declaration)
    if (described.some((seen) => seen.id === node.id)) continue
    described.push(node)
  }
  return described
    .map(serialize)
    .filter((part) => part.length > 0)
    .join(" ")
}

/**
 * What describes one declaration: its body when the body is the declaration's own, and the whole
 * declaration when the body is a function written somewhere inside it.
 *
 * "Its own" is read from the tree — the body is a direct child of the declaration's node — and
 * that rests on how every producer pairs the two. A function, method, accessor, constructor, a
 * field or a `const` holding a function, a class and an interface each pair a body with the node
 * it is written in, so they are described by the body. A call Symbol (LP20i) and a `const`
 * initialised by a call (LP7c) pair the body of a function they hand a call with the whole
 * declaration, so they are described by the declaration, and `withAuth(async (req) => …)` →
 * `withRole(async (req) => …)` moves the `syntax` axis. A producer that widened its full node
 * past its body's parent would move every fingerprint of that kind, which is why
 * `what-describes-a-declaration.test.ts` pins each producer's answer.
 */
function describedNode(declaration: Pick<MergedDeclaration<Node>, "bodyNode" | "fullNode">): Node {
  const { bodyNode, fullNode } = declaration
  return bodyNode !== null && bodyNode.parent?.id === fullNode.id ? bodyNode : fullNode
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
