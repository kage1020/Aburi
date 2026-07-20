/**
 * Minimal shape of a web-tree-sitter Node the plugin needs. Duck-typed so this package
 * does not take a direct `web-tree-sitter` dependency; the plugin is already pinned to
 * lang-typescript's tree-sitter output through `OpaqueAstNode`.
 */
export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly (SyntaxNode | null)[]
  readonly children: readonly (SyntaxNode | null)[]
  childForFieldName(name: string): SyntaxNode | null
}

/**
 * Narrow `OpaqueAstNode | null` to `SyntaxNode` when the underlying value has the
 * tree-sitter surface. Returns `null` for anything else so a lang plugin that hands us a
 * non-tree-sitter node does not blow up mid-walk.
 */
export function asSyntaxNode(value: unknown): SyntaxNode | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<SyntaxNode>
  if (typeof candidate.type !== "string") return null
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
}

/**
 * Pre-order walk that returns the first descendant whose `type` matches `typeName`, or
 * `null` if none is found. Pre-order guarantees the outermost occurrence wins — important
 * for `findFirstCallExpression` where a wrapping `forwardRef(...)` must be returned
 * before any inner render-body call it contains.
 */
export function findFirstDescendantOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  if (node.type === typeName) return node
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = findFirstDescendantOfType(child, typeName)
    if (found !== null) return found
  }
  return null
}

/**
 * Extract the callee text of a `call_expression` node. Handles both plain-identifier
 * callees (`forwardRef`) and member expressions (`React.forwardRef`), returning the raw
 * source verbatim so downstream string comparison ("createContext" vs "React.createContext")
 * needs no additional shape awareness.
 */
export function calleeText(callNode: SyntaxNode): string | null {
  const fn = callNode.childForFieldName("function")
  if (fn === null) return null
  return fn.text
}

/**
 * Walk `bodyNode` looking for a `call_expression` whose callee's leaf identifier
 * satisfies `predicate`. Only the leaf is inspected — a member expression `foo.bar.useX()`
 * is treated as calling `useX` for the purposes of "does this function call another
 * hook" style detection.
 */
export function anyCallCalleeMatches(
  bodyNode: SyntaxNode,
  predicate: (leaf: string) => boolean,
): boolean {
  if (bodyNode.type === "call_expression") {
    const callee = calleeText(bodyNode)
    if (callee !== null) {
      const leaf = calleeLeaf(callee)
      if (predicate(leaf)) return true
    }
  }
  for (const child of bodyNode.namedChildren) {
    if (child === null) continue
    if (anyCallCalleeMatches(child, predicate)) return true
  }
  return false
}

/**
 * Reduce a member-expression callee ("React.forwardRef" / "foo.bar.baz") to its leaf
 * identifier ("forwardRef" / "baz"). A callee with no `.` returns unchanged.
 */
export function calleeLeaf(callee: string): string {
  const dot = callee.lastIndexOf(".")
  return dot < 0 ? callee : callee.slice(dot + 1)
}
