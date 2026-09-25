import type { Node, Parser, Tree } from "web-tree-sitter"

/**
 * A second parse for the `import("…")` types the grammar reads as a call and cannot place
 * (`lang-plugin.md` LP27b).
 *
 * Every other type position accepts a bare name, so the file is parsed once more with each such
 * `import(…)` replaced by an identifier exactly as long: `typeof $____________`,
 * `$____________.Rule[]`. Same length, so every offset, line and column is the original's. The
 * parse reads the masked text, and the tree it returns reads the original: web-tree-sitter keeps
 * the input callback on the Tree and answers `node.text` through it, so the callback serves the
 * masked text while the parser runs and the original from then on. Every consumer of the tree —
 * this plugin, `@aburi/core`, a framework plugin — sees `typeof import("./m")`, never the mask.
 *
 * Only an `import(…)` under an error is masked, so a Symbol's fingerprint does not move because
 * another statement in the file carries the idiom. A mask the second parse does not read as a
 * type is withdrawn, since `await import("./m")` masked would lose its import edge.
 */

/**
 * The tree to use instead of `tree`, or `null` to keep it. Never deletes `tree`; a returned tree
 * is the caller's to delete.
 */
export function reparseImportTypes(
  parser: Parser,
  tree: Tree,
  source: string,
  errorCount: (tree: Tree) => number,
): Tree | null {
  let spans = maskableImportTypes(tree)
  while (spans.length > 0) {
    const candidate = parseMasked(parser, source, spans)
    if (candidate === null) return null
    const kept = spans.filter((span) => readsAsType(candidate, span))
    if (kept.length === spans.length) {
      if (errorCount(candidate) < errorCount(tree)) return candidate
      candidate.delete()
      return null
    }
    candidate.delete()
    spans = kept
  }
  return null
}

interface Span {
  start: number
  end: number
}

/**
 * Every `import("…")` call in a statement that holds an error, or inside an ERROR node, as a span
 * of the source. "Statement" is the nearest enclosing statement or declaration, so a type alias
 * that parsed keeps its tree even in a body broken elsewhere; an ERROR at module level has no
 * statement around it, and the well-formed pieces recovery keeps as its children are searched
 * too. A call with anything but a single string argument is not a type, and one spanning a line
 * break could not become one identifier without moving the lines after it.
 */
function maskableImportTypes(tree: Tree): Span[] {
  const spans: Span[] = []
  const stack: { node: Node; broken: boolean }[] = [{ node: tree.rootNode, broken: false }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, broken } = item
    if (broken && isMaskable(node)) spans.push({ start: node.startIndex, end: node.endIndex })
    for (const child of node.namedChildren) {
      if (child === null || !(broken || child.hasError)) continue
      const childBroken = STATEMENT.test(child.type) ? child.hasError : broken || child.isError
      stack.push({ node: child, broken: childBroken })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

const STATEMENT = /_(statement|declaration|definition|signature)$/

function isMaskable(node: Node): boolean {
  if (node.type !== "call_expression") return false
  if (node.childForFieldName("function")?.type !== "import") return false
  const args = node.childForFieldName("arguments")
  if (args?.namedChildCount !== 1 || args.namedChild(0)?.type !== "string") return false
  return !/[\r\n\u2028\u2029]/.test(node.text)
}

function parseMasked(parser: Parser, source: string, spans: readonly Span[]): Tree | null {
  let masked = ""
  let from = 0
  for (const { start, end } of spans) {
    masked += source.slice(from, start) + "$".padEnd(end - start, "_")
    from = end
  }
  masked += source.slice(from)
  let parsing = true
  const tree = parser.parse((index) => (parsing ? masked : source).slice(index))
  parsing = false
  return tree
}

/**
 * Whether the mask at `span` reads as the module of a type: the operand of `typeof`, or the head
 * of a qualified type name (`$___.Rule`, `$___.a.B`), directly or through a member access.
 */
function readsAsType(tree: Tree, span: Span): boolean {
  let node: Node | null = tree.rootNode.namedDescendantForIndex(span.start, span.end)
  if (node === null || node.type !== "identifier") return false
  if (node.startIndex !== span.start || node.endIndex !== span.end) return false
  let parent: Node | null = node.parent
  while (
    parent !== null &&
    (parent.type === "member_expression" || parent.type === "nested_identifier") &&
    parent.namedChild(0)?.id === node.id
  ) {
    node = parent
    parent = parent.parent
  }
  if (parent === null) return false
  if (parent.type === "type_query") return true
  return parent.type === "nested_type_identifier" && parent.namedChild(0)?.id === node.id
}
