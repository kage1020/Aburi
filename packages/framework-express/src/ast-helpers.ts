import type { SyntaxNode } from "@aburi/core"

// Restated from lang-typescript, which names the registration by this path: the two must agree.
export function isPathLiteral(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type === "string") return true
  if (value.type !== "template_string") return false
  return value.namedChildren.every((child) => child?.type !== "template_substitution")
}

// `<T>x` is left out because lang-typescript does not read through it when naming the Symbol.
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

export function unwrapValue(node: SyntaxNode): SyntaxNode {
  let cursor = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = cursor.namedChildren.find((child) => child !== null && child.type !== "comment")
    if (inner === undefined || inner === null) return cursor
    cursor = inner
  }
  return cursor
}

export function writtenChildren(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return []
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}
