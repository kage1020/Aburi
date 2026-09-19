/**
 * Duck-typed subset of the tree-sitter `Node` surface, for plugins that receive an
 * `OpaqueAstNode` from `@aburi/lang-typescript` and want to walk it without taking their own
 * `web-tree-sitter` dependency. Every member declared here is asserted by `asSyntaxNode`,
 * because that guard is the only thing standing between a plugin's node and code that reads
 * these members unconditionally — a member left unchecked fails as a `TypeError` past the very
 * check meant to keep a non-tree-sitter value out.
 */
export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly (SyntaxNode | null)[]
  readonly children: readonly (SyntaxNode | null)[]
  childForFieldName(name: string): SyntaxNode | null
}

/**
 * Narrow an opaque value to `SyntaxNode`, or `null` when it lacks the tree-sitter surface.
 *
 * `children` is asserted although nothing in this module reads it, because the caller does:
 * `asSyntaxNode` is the single narrowing point for every plugin, and `framework-react`'s JSX
 * walk iterates `children` straight off the value this returns.
 */
export function asSyntaxNode(value: unknown): SyntaxNode | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<SyntaxNode>
  if (typeof candidate.type !== "string") return null
  if (typeof candidate.text !== "string") return null
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
}

/** The first direct named child of the given `type`, or `null`. */
export function findNamedChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

/**
 * Pre-order search for the first descendant (the node itself included) of the given `type`.
 * Pre-order means the outermost occurrence wins, which is what a wrapper-call detector wants.
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
 * The verbatim source of a `call_expression`'s `function` field (`forwardRef`,
 * `React.forwardRef`, `app.route("/x").get`), or `null` when the field is missing or empty.
 */
export function calleeText(callNode: SyntaxNode): string | null {
  const callee = callNode.childForFieldName("function")
  if (callee === null) return null
  return callee.text.length > 0 ? callee.text : null
}

/** The last dotted segment of a callee string (`app.route('/x').get` → `get`). */
export function calleeLeaf(callee: string): string {
  const dot = callee.lastIndexOf(".")
  return dot < 0 ? callee : callee.slice(dot + 1)
}

/** True when any `call_expression` under `node` (itself included) has a callee leaf `predicate` accepts. */
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
