import type { Node } from "web-tree-sitter"

/** True when the given node is null. Terse helper because tree-sitter APIs return `Node | null` everywhere. */
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
