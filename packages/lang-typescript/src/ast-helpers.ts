import type { ExtractionContext, SymbolCandidate, WrittenSourceRange } from "@aburi/types"
import type { Node } from "web-tree-sitter"

/**
 * Every body a Symbol was declared with: the leading declaration's, followed by the bodies of
 * the declarations that merged into it, in source order.
 *
 * A getter and its setter are one member written twice, and so are an interface reopened and
 * a namespace augmenting the class above it. Anything that reads a body to describe the
 * Symbol — the body walk, the empty-body hint — has to read all of them, or it describes
 * whichever declaration was written first. A merged declaration with no body of its own
 * contributes nothing here; `normalizeAst` is the reader that falls back to its `fullNode`.
 */
export function bodyNodesOf(symbol: SymbolCandidate<Node>): Node[] {
  const out: Node[] = symbol.bodyNode === null ? [] : [symbol.bodyNode]
  for (const declaration of symbol.mergedDeclarations ?? []) {
    if (declaration.bodyNode !== null) out.push(declaration.bodyNode)
  }
  return out
}

/**
 * The single writer of `SourceRange` in this plugin — both the declaration extractor and
 * the promoted-call extractor go through here.
 *
 * Both column keys are emitted unconditionally as `null`. The tree has the columns in hand
 * (`node.startPosition.column`), and nothing in the plugin contract forbids publishing them
 * (`docs/design/lang-plugin.md` §4.3) — this plugin withholds them by choice, so that every
 * column in an Aburi IR comes from `textDocument/documentSymbol` and one convention about
 * what a column counts, rather than from two tiers that may disagree. The choice costs
 * nothing today: `applyDocumentSymbols` in `packages/core/src/lsp/enrich.ts` overwrites both
 * keys whenever the LSP pass matches the Symbol, so a column written here would survive only
 * on the runs where no column is available anyway.
 *
 * `null` rather than an omitted key is the Class A rule of `ir-schema.md` §1.1.
 */
export function makeSourceRange(node: Node, ctx: ExtractionContext): WrittenSourceRange {
  return {
    file: ctx.file.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: null,
    endColumn: null,
  }
}

/**
 * The function a declaration's `value` field holds, or null when it holds anything else.
 *
 * One set, read wherever a binding is decided to be a function rather than data: `const f =
 * () => …` at module level and `class C { f = () => … }` inside a class body answer the same
 * question the same way. A generator (`function* () {}`) is outside it at both levels.
 */
export function functionValueOf(node: Node): Node | null {
  const value = node.childForFieldName("value")
  return value === null ? null : asFunctionValue(value)
}

/**
 * The wrapper node types that say nothing about the value inside them.
 *
 * A `satisfies` or `as` names a type the value must fit, a `!` asserts it is not null, and a
 * parenthesis groups. None of them replaces the value, so a function written inside one is
 * still the function that binding holds — which is what the declaration extractor, the class
 * field predicate, the argument scan and the default-export reader all have to agree on.
 *
 * A **call** is not on this list. `withAuth(() => …)` returns a function by convention, and
 * nothing in the tree says so; reading through it would be a guess rather than an unwrap.
 */
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

/**
 * The value inside every wrapper around `node`, or `node` itself when there are none.
 *
 * The wrapped expression comes first in all four: `as` and `satisfies` put the type second,
 * and so does a parenthesis carrying one (`(f: T)`). An empty wrapper — only reachable from a
 * half-edited file the grammar recovered — answers with the wrapper, since there is nothing
 * inside to answer with.
 *
 * The old-style assertion `<T>(expr)` is deliberately not on the list. It is a `type_assertion`
 * whose **first** named child is the type, so the rule above inverts on it, and it is
 * deprecated and unparseable by the tsx grammar — adding it would need its own reader for a
 * spelling most of this plugin's own extensions cannot use.
 */
export function unwrapValue(node: Node): Node {
  let cursor: Node = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = firstNonCommentChild(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}

/**
 * `node` as a function, reading through any wrappers around it, or null when what is inside
 * them is not a function.
 */
export function asFunctionValue(node: Node): Node | null {
  const value = unwrapValue(node)
  const isFunction = value.type === "arrow_function" || value.type === "function_expression"
  return isFunction ? value : null
}

/** True when the node has a child of this type, named or anonymous (`static`, `get`, `set`). */
/**
 * An ERROR or a MISSING token among a node's **own** children — its head, never its body.
 *
 * What it answers is "did the parser guess at this node's own text?", and that is the question
 * both readers of a written name ask: a class member's name (`memberNameSegment`) and a
 * bracket access's index (`subscriptSegment`). Recovery re-emits the characters it could
 * salvage as an ordinary node and drops an ERROR beside them, so a name that looks whole is
 * not evidence that it was read — `class C { "\uZZZZ"() {} }` recovers as a member called
 * `ZZZZ`, and `prisma["user" "audit"]` recovers with `"audit"` in the index field.
 *
 * Deliberately not `node.hasError`: a broken body or argument list nests its ERROR deeper and
 * leaves the head alone, so a typo inside a member would otherwise cost the member its name.
 */
export function hasErrorChild(node: Node): boolean {
  return node.children.some(
    (child) => child !== null && (child.type === "ERROR" || child.isMissing),
  )
}

export function hasChildOfType(node: Node, typeName: string): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === typeName) return true
  }
  return false
}

/** Type guard: true when the given node is NOT null. Tree-sitter APIs return `Node | null` everywhere. */
export function isPresent(node: Node | null): node is Node {
  return node !== null
}

/**
 * Find the first named child whose type matches `typeName`. Returns null when nothing
 * matches; walkers use this instead of manual for-loops for the common case.
 */
export function findChild(node: Node, typeName: string): Node | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

/**
 * The first named child that is not a comment, or null when there is none.
 *
 * A comment is a *named* node and tree-sitter puts it wherever it was written, so anything
 * reaching for "the first child" by position finds the comment instead of the thing it meant
 * — the expression a decorator applies, the specifier a dynamic import names. Both cases are
 * silent: the reader either names the construct after the comment or drops it altogether.
 */
export function firstNonCommentChild(node: Node): Node | null {
  for (const child of node.namedChildren) {
    if (child === null || child.type === "comment") continue
    return child
  }
  return null
}

/**
 * Yield every descendant node in a pre-order depth-first walk. Cheap iterator so callers
 * that only want to inspect nodes of a certain type do not have to write the traversal
 * themselves.
 */
export function* walkDescendants(root: Node): Iterable<Node> {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    yield node
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i)
      if (child !== null) stack.push(child)
    }
  }
}

/**
 * The wrapper tree-sitter puts between a `declare` and the declaration it was written on.
 * `declare function f(): void` is an `ambient_declaration` holding a `function_signature`, and
 * `export declare class C {}` puts one between the `export_statement` and the class.
 */
export const AMBIENT_DECLARATION_TYPE = "ambient_declaration"

/**
 * True when the node is written under a `declare`, at any namespace depth inside it.
 *
 * What it decides is whether a **signature is the declaration or an overload of one**. A
 * `function_signature` at module level is an overload: the implementation written beside it
 * carries the body and the parameter types the function is actually called with, so the
 * signature is not a Symbol of its own. An ambient context has no implementations at all —
 * `declare function f(): void` is the whole declaration — so there is nothing beside it to
 * defer to. The same split separates an ordinary class body's `method_signature` from a
 * `declare class`'s, which is why one predicate answers for both.
 *
 * It reads the parent chain rather than a flag threaded through the statement walk, because the
 * class-member question is asked by two readers that are handed the class node and nothing else
 * (`memberSymbolSegment`) — and the moment those two disagree a body is recorded twice or not
 * at all. The chain climbed is bounded by declaration nesting depth — it runs through the
 * `statement_block`, `export_statement`, `expression_statement` and `ambient_declaration`
 * wrappers between a declaration and the module — and `program` ends it.
 */
export function inAmbientContext(node: Node): boolean {
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === AMBIENT_DECLARATION_TYPE) return true
    if (cursor.type === "program") return false
  }
  return false
}

/** Return the identifier text of a node's `name` field, or null when absent. */
export function nameFieldText(node: Node): string | null {
  const name = node.childForFieldName("name")
  if (name === null) return null
  const text = name.text
  return text.length > 0 ? text : null
}

/**
 * The statement `node` was written as, seen from the declaration: its parent, with a `declare`
 * wrapper stepped over.
 *
 * Tree-sitter-typescript wraps a declaration's modifiers at the statement level, and `export
 * declare class C {}` uses both wrappers at once — the class is parented in an
 * `ambient_declaration` and *that* in the `export_statement`. A reader taking the immediate
 * parent finds the wrapper rather than the export, so every reader of a declaration's statement
 * position comes through here instead of reading `node.parent` itself.
 */
export function statementParent(node: Node): Node | null {
  const parent = node.parent
  if (parent !== null && parent.type === AMBIENT_DECLARATION_TYPE) return parent.parent
  return parent
}

/**
 * True when the declaration was written under an `export` keyword.
 *
 * This is the one implementation of that question. `extract-symbols` asks it under its own
 * name, `hasExportKeywordAncestor`, which reads better beside the other questions that file
 * asks of a declaration — but it delegates here rather than repeating these two lines. A second
 * copy is how a reader that stops at `node.parent` gets written again, and that reader is the
 * one `export declare class C {}` was invisible to: its export is a node further up.
 */
export function hasExportModifier(node: Node): boolean {
  const parent = statementParent(node)
  return parent !== null && parent.type === "export_statement"
}
