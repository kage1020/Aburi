import type { ExtractionContext, WrittenSourceRange } from "@aburi/types"
import type { Node } from "web-tree-sitter"

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

/** Return the identifier text of a node's `name` field, or null when absent. */
export function nameFieldText(node: Node): string | null {
  const name = node.childForFieldName("name")
  if (name === null) return null
  const text = name.text
  return text.length > 0 ? text : null
}

/** True when the given statement has an `export` keyword modifier at its root. */
export function hasExportModifier(node: Node): boolean {
  // Tree-sitter-typescript wraps exports at the statement level: an exported function is
  // an `export_statement` whose first named child is the declaration. When we look at the
  // declaration itself, the export is the parent's concern.
  const parent = node.parent
  return parent !== null && parent.type === "export_statement"
}
