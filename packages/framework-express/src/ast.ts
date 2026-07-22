/**
 * Duck-typed subset of the tree-sitter `Node` surface. Framework plugins avoid a direct
 * runtime dependency on `web-tree-sitter` by only asserting the members they read, so a
 * SymbolCandidate arriving with `fullNode` typed as `OpaqueAstNode` can be inspected via
 * `asSyntaxNode` and then walked with the helpers below.
 */
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
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
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

/** Read the text of the call's `function` field (identifier, member expression, or
 * chained call). Returns null when the field is missing or empty. */
export function calleeText(callNode: SyntaxNode): string | null {
  const fn = callNode.childForFieldName("function")
  if (fn === null) return null
  const text = fn.text
  return text.length > 0 ? text : null
}

/** Return the last dotted segment of a callee string (`app.route('/x').get` → `get`). */
export function calleeLeaf(callee: string): string {
  const dot = callee.lastIndexOf(".")
  return dot < 0 ? callee : callee.slice(dot + 1)
}

/** Return the leftmost identifier-like segment of a callee string
 * (`app.route('/x').get` → `app`). Everything after the first `.` or `(` is dropped. */
export function calleeRoot(callee: string): string {
  const stop = firstBreakIndex(callee)
  return stop < 0 ? callee : callee.slice(0, stop)
}

function firstBreakIndex(callee: string): number {
  const dot = callee.indexOf(".")
  const paren = callee.indexOf("(")
  if (dot < 0) return paren
  if (paren < 0) return dot
  return Math.min(dot, paren)
}
