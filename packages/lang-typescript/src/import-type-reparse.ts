import type { Node, Parser, Tree } from "web-tree-sitter"
import { decodeStringLiteralOrRaw } from "./string-escape"

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
    let adopted = false
    try {
      const kept = spans.filter((span) => readsAsType(candidate, span))
      if (kept.length < spans.length) {
        spans = kept
        continue
      }
      if (errorCount(candidate) >= errorCount(tree)) return null
      MASKS.set(candidate, new Map(spans.map((span) => [span.start, span.specifier])))
      adopted = true
      return candidate
    } finally {
      if (!adopted) candidate.delete()
    }
  }
  return null
}

export function maskedImportSpecifier(node: Node): string | undefined {
  return MASKS.get(node.tree)?.get(node.startIndex)
}

/** Per adopted tree, the specifier of each mask by its start offset. */
const MASKS = new WeakMap<Tree, Map<number, string>>()

interface Span {
  start: number
  end: number
  specifier: string
}

function maskableImportTypes(tree: Tree): Span[] {
  const spans: Span[] = []
  const root = tree.rootNode
  const stack: { node: Node; broken: boolean }[] = [{ node: root, broken: root.isError }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, broken } = item
    const specifier = broken ? maskableSpecifier(node) : null
    if (specifier !== null) spans.push({ start: node.startIndex, end: node.endIndex, specifier })
    for (const child of node.namedChildren) {
      if (child === null || !(broken || child.hasError)) continue
      const childBroken = STATEMENT.test(child.type) ? child.hasError : broken || child.isError
      stack.push({ node: child, broken: childBroken })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

const STATEMENT = /_(statement|declaration|definition|signature)$/

function maskableSpecifier(node: Node): string | null {
  if (node.type !== "call_expression") return null
  if (node.childForFieldName("function")?.type !== "import") return null
  const args = node
    .childForFieldName("arguments")
    ?.namedChildren.filter((n) => n?.type !== "comment")
  if (args === undefined || args.length === 0 || args.length > 2) return null
  if (args.length === 2 && args[1]?.type !== "object") return null
  const first = args[0]
  if (first?.type !== "string" || /[\r\n\u2028\u2029]/.test(node.text)) return null
  const specifier = decodeStringLiteralOrRaw(first)
  return specifier === "" ? null : specifier
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
