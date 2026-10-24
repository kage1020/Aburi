import { type SyntaxNode, unwrapValue } from "@aburi/core"

// Restated from lang-typescript, which names the registration by this path: the two must agree.
export function isPathLiteral(node: SyntaxNode): boolean {
  const value = unwrapValue(node)
  if (value.type === "string") return true
  if (value.type !== "template_string") return false
  return value.namedChildren.every((child) => child?.type !== "template_substitution")
}

export function writtenChildren(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return []
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}
