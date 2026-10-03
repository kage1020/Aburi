import type { MergedDeclaration, SymbolCandidate } from "@aburi/types"
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
 * A class's description is its body followed by its head (`classHead`), which the body leaves
 * out and nothing else reads.
 *
 * A Symbol several declarations wrote — a getter beside its setter, an interface reopened, a
 * class beside an interface or a namespace — describes the leading declaration and then each
 * further one in source order, a class's head straight after that class's own body. So a class
 * keeps its head whichever declaration leads, and the string is each declaration's string
 * alone, joined. Each declaration is described once: a const that hands its call two functions
 * has two bodies but one declaration, and both bodies name it (`inlineHandlers`).
 *
 * So giving a const a body moved no existing fingerprint, for three reasons that each have to
 * keep holding: a Symbol with one declaration serializes as that declaration's description and
 * nothing else; a const that gained a body is described by the declaration that described it
 * while it had none; and a declaration is described once, so a second function adds no second
 * copy. A class's head moved only the classes that have one, since an empty head adds nothing.
 */
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

/**
 * What a class's declaration says outside its body: `abstract`, its type parameters, and its
 * `extends` / `implements`. Empty for a class with none, so that class keeps the string it had.
 * A class has no signature (`fingerprint.md` §3.1), so without this a change to any of them
 * reached no axis, though each moves the class's contract and `fingerprint.md` §5.4 already
 * asks the syntax axis to see a renamed identifier or a changed modifier. The case in full, and
 * where it stops, is `lang-plugin.md` LP8p.
 *
 * `class` is the node type of an anonymous `export default class`. A class expression a `const`
 * holds never arrives as a full node: that Symbol is described by its whole declaration, head
 * included.
 */
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

/**
 * Every node type a class Symbol's declaration can have. Not `CLASS_DECLARATION_TYPES` in
 * `extract-symbols.ts`, which looks for a *named* class to merge a namespace into and so leaves
 * `class` out.
 */
const CLASS_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
])

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
