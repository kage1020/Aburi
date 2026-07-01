import type { ImportEdge } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"

/**
 * Walk the top level of the parsed module and produce an ImportEdge per import site.
 *
 * Covers the three shapes the design contract enumerates:
 *   - Static named / default / mixed:  `import Foo, { A as B, C } from './x'`
 *   - Namespace:                       `import * as Foo from 'z'`
 *   - Dynamic:                         `await import('./x')`, `import('./x').then(...)`
 *
 * Type-only imports (`import type {...}`) still produce an ImportEdge — the design does not
 * separate value and type edges, and downstream consumers can use component / language
 * information if they need to filter.
 */
export function extractImports(tree: Tree, _source: string): ImportEdge[] {
  const edges: ImportEdge[] = []
  const root = tree.rootNode
  if (root === null) return edges

  for (const child of root.namedChildren) {
    if (child === null) continue
    if (child.type === "import_statement") {
      const edge = readImportStatement(child)
      if (edge !== null) edges.push(edge)
    } else if (child.type === "export_statement") {
      const edge = readReExport(child)
      if (edge !== null) edges.push(edge)
    }
  }

  // Dynamic imports can appear anywhere in the tree, so scan the whole thing separately.
  walkForDynamicImports(root, edges)

  edges.sort((a, b) => a.line - b.line || cmpString(a.source, b.source))
  return dedupeEdges(edges)
}

/**
 * `import ... from '...'` — read the module specifier and the imported symbol list. Missing
 * clauses (bare `import './side-effect'`) still produce a `"*"` edge so the dependency
 * relationship is visible in the IR.
 */
function readImportStatement(node: Node): ImportEdge | null {
  const source = readStringLiteral(node.childForFieldName("source"))
  if (source === null) return null
  const line = node.startPosition.row + 1
  const clause = node.childForFieldName("import_clause") ?? findChildByType(node, "import_clause")
  if (clause === null) {
    return { source, symbols: "*", line, dynamic: false }
  }
  const symbols = readImportClause(clause)
  return { source, symbols, line, dynamic: false }
}

/**
 * The import clause holds one or more of: default binding, namespace binding, named
 * bindings. Namespace bindings collapse the whole clause to `"*"` because that is how
 * downstream dependency analysis should treat them.
 */
function readImportClause(clause: Node): string[] | "*" {
  const names: string[] = []
  for (const child of clause.namedChildren) {
    if (child === null) continue
    switch (child.type) {
      case "namespace_import":
        return "*"
      case "identifier":
        // Default import binding: `import Foo from './x'` — the identifier IS the binding
        // name that downstream code will use, so include it verbatim.
        names.push(child.text)
        break
      case "named_imports":
        for (const spec of child.namedChildren) {
          if (spec === null || spec.type !== "import_specifier") continue
          // `{ A }` or `{ A as B }` — the exported name (A) is what appears in dependency
          // analysis, not the local rebind (B). Field name follows tree-sitter-typescript's
          // grammar.
          const exportedName = spec.childForFieldName("name")
          if (exportedName !== null && exportedName.type === "identifier") {
            names.push(exportedName.text)
          }
        }
        break
    }
  }
  return names.length > 0 ? names : "*"
}

/**
 * `export { X } from './y'` — a re-export is functionally a dependency on `./y`, so surface
 * it as a static ImportEdge. `export * from './y'` collapses to `"*"`.
 */
function readReExport(node: Node): ImportEdge | null {
  const source = readStringLiteral(node.childForFieldName("source"))
  if (source === null) return null
  const line = node.startPosition.row + 1

  const namespaceExport = findChildByType(node, "namespace_export")
  if (namespaceExport !== null) {
    return { source, symbols: "*", line, dynamic: false }
  }

  const clauseNode = findChildByType(node, "export_clause")
  if (clauseNode === null) {
    return { source, symbols: "*", line, dynamic: false }
  }
  const names: string[] = []
  for (const spec of clauseNode.namedChildren) {
    if (spec === null || spec.type !== "export_specifier") continue
    const name = spec.childForFieldName("name")
    if (name !== null && name.type === "identifier") names.push(name.text)
  }
  return { source, symbols: names.length > 0 ? names : "*", line, dynamic: false }
}

/**
 * Dynamic imports use the `import(...)` grammar (a call expression whose callee is the
 * `import` keyword). Walk the tree and emit an edge for every one we find.
 */
function walkForDynamicImports(root: Node, out: ImportEdge[]): void {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function")
      if (callee !== null && callee.type === "import") {
        const args = node.childForFieldName("arguments")
        const specifier = args !== null ? readStringLiteral(args.namedChild(0)) : null
        if (specifier !== null) {
          out.push({
            source: specifier,
            symbols: "*",
            line: node.startPosition.row + 1,
            dynamic: true,
          })
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) stack.push(child)
    }
  }
}

/**
 * Read a `string` node's contents, stripping the surrounding quotes. Tree-sitter's
 * TypeScript grammar exposes the raw quoted text on `.text` and named children carry the
 * string fragments; we only need the concatenated fragments so template-like strings
 * degrade gracefully.
 */
function readStringLiteral(node: Node | null): string | null {
  if (node === null) return null
  if (node.type !== "string") return null
  // Named children of a string node are fragments (`string_fragment`, `escape_sequence`).
  // Concatenating their text reconstructs the raw specifier without the enclosing quotes.
  const parts: string[] = []
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (child.type === "string_fragment") parts.push(child.text)
  }
  if (parts.length > 0) return parts.join("")
  // Fallback: strip the outer quotes manually. Works for empty string literals.
  const raw = node.text
  if (raw.length >= 2 && /^["'`]/.test(raw)) return raw.slice(1, -1)
  return raw
}

function findChildByType(node: Node, type: string): Node | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === type) return child
  }
  return null
}

function dedupeEdges(edges: readonly ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>()
  const out: ImportEdge[] = []
  for (const edge of edges) {
    const key = `${edge.line}\t${edge.source}\t${edge.dynamic}\t${JSON.stringify(edge.symbols)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
