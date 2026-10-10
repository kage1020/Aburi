export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly (SyntaxNode | null)[]
  readonly children: readonly (SyntaxNode | null)[]
  childForFieldName(name: string): SyntaxNode | null
}

export function asSyntaxNode(value: unknown): SyntaxNode | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<SyntaxNode>
  if (typeof candidate.type !== "string") return null
  if (typeof candidate.text !== "string") return null
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
}

export function findNamedChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

export function findFirstDescendantOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  if (node.type === typeName) return node
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = findFirstDescendantOfType(child, typeName)
    if (found !== null) return found
  }
  return null
}

export function calleeText(callNode: SyntaxNode): string | null {
  const callee = callNode.childForFieldName("function")
  if (callee === null) return null
  return callee.text.length > 0 ? callee.text : null
}

export function calleeLeaf(callee: string): string {
  const dot = callee.lastIndexOf(".")
  return dot < 0 ? callee : callee.slice(dot + 1)
}

export function anyCallCalleeMatches(
  node: SyntaxNode,
  predicate: (leaf: string) => boolean,
): boolean {
  if (node.type === "call_expression") {
    const callee = calleeText(node)
    if (callee !== null && predicate(calleeLeaf(callee))) return true
  }
  for (const child of node.namedChildren) {
    if (child !== null && anyCallCalleeMatches(child, predicate)) return true
  }
  return false
}
