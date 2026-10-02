import type { SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Emit a positionless, comment-free S-expression for a SymbolCandidate's body.
 *
 * The output is the input to `syntaxFingerprint` in `@aburi/core`, so it must satisfy the
 * plugin contract there:
 *   - no comment nodes (we skip `comment` and `hash_bang_line` nodes)
 *   - no position information (byte offsets, rows, columns are all omitted)
 *   - no whitespace tokens, and nothing tree-sitter marks `extra`: comments, and the ERROR
 *     nodes it wraps unparseable text in, so a subtree the parser gave up on is left out whole
 *   - node kinds and child structure, plus every anonymous token, quoted, except the ones
 *     in `FORMATTING_TOKENS` (see `tokenPayload`)
 *   - identifier and literal values ARE included — the syntax axis is sensitive to what
 *     the code says, not just how it is shaped
 *
 * When the SymbolCandidate has a `bodyNode`, that node is normalized (the class /
 * function body). When it does not (`type` / `interface` / bare `const`), the full node
 * is normalized instead so type aliases and interface shapes still get a stable hash.
 *
 * A Symbol whose declaration is a **call** is the exception, and is always described by its
 * full node. Its body is a function written inside that call, so narrowing to the body would
 * drop the registration itself: `app.get('/x', authenticate, h)` and `app.get('/x', h)` would
 * serialize identically, and adding or removing a route's auth middleware would produce no
 * signal on any axis. The body is what the registration *runs*, which is the walk's question;
 * the whole call is what it *is*, which is this one.
 *
 * A Symbol several declarations wrote — a getter beside its setter, an interface reopened —
 * gets each of the further bodies appended, in source order. A Symbol with one declaration
 * therefore serializes to exactly the string it did before that was possible, which is what
 * keeps every existing fingerprint where it was: appending is the only new behaviour, and
 * there is nothing to append.
 */
export function normalizeAst(symbol: SymbolCandidate<Node>): string {
  if (symbol.kind === "call") return serialize(symbol.fullNode)
  const merged = symbol.mergedDeclarations ?? []
  const primary = serialize(symbol.bodyNode ?? symbol.fullNode)
  if (merged.length === 0) return primary
  const parts = [primary, ...merged.map((d) => serialize(d.bodyNode ?? d.fullNode))]
  return parts.filter((part) => part.length > 0).join(" ")
}

function serialize(node: Node): string {
  if (node.isExtra) return ""
  if (SKIPPED_NODE_TYPES.has(node.type)) return ""

  const children: string[] = []
  let previous: Node | null = null
  for (const child of node.children) {
    // A MISSING node is the parser's repair, not something written. Reading it would hash a
    // broken body like its repaired form.
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

/**
 * An anonymous token, quoted so it cannot be read as a node type, or `""` for a token in
 * `FORMATTING_TOKENS`.
 *
 * Operators and keywords are anonymous in tree-sitter — `a + b` and `a - b` are one
 * `binary_expression` over two identifiers, and `let` and `const` one `lexical_declaration` —
 * so a walk over named children alone reads both edits as no change. Every token is kept
 * except the ones a formatter adds, drops or swaps without changing the program.
 */
function tokenPayload(token: Node, previous: Node | null, parent: Node): string {
  if (token.isExtra) return ""
  if (isElision(token, previous, parent)) return JSON.stringify(token.type)
  if (FORMATTING_TOKENS.has(token.type)) return ""
  return JSON.stringify(token.type)
}

/**
 * A comma that stands for a hole in an array or an array pattern. `[, token]` binds the second
 * element where `[token]` binds the first, and `[1, , 3]` has three elements where `[1, 3]` has
 * two, but the grammar has no node for a hole: the commas are all that records it. A comma
 * right after `[` or after another comma is therefore kept. Every other comma separates
 * elements the structure already counts, a trailing one included, and stays out.
 */
function isElision(token: Node, previous: Node | null, parent: Node): boolean {
  if (token.type !== "," || !ELIDING_TYPES.has(parent.type)) return false
  return previous?.type === "[" || previous?.type === ","
}

const ELIDING_TYPES: ReadonlySet<string> = new Set(["array", "array_pattern"])

/**
 * The tokens a formatter owns: string delimiters (`'a'` and `"a"`), separators (an optional
 * `;`, a trailing `,`, `;` against `,` between interface members) and the brackets the named
 * structure already implies (`arguments` always has its parentheses, `statement_block` its
 * braces). It is this plugin's answer to what `fingerprint.md` §5.1 item 4 leaves out.
 */
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
