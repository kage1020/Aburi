import { compareCodeUnit, DEFAULT_EXPORT_NAME } from "@aburi/core"
import type { ImportEdge, ParseError } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, firstNonCommentChild, walkDescendants } from "./ast-helpers"
import { maskedImportSpecifier } from "./import-type-reparse"
import { readStaticString } from "./string-escape"

export interface ImportExtraction {
  edges: ImportEdge[]
  errors: ParseError[]
}

export function extractImports(tree: Tree, _source: string): ImportExtraction {
  const edges: ImportEdge[] = []
  const errors: ParseError[] = []
  const root = tree.rootNode
  if (root === null) return { edges, errors }

  for (const child of root.namedChildren) {
    if (child === null) continue
    if (child.type === "import_statement") {
      for (const edge of readImportStatement(child, errors)) edges.push(edge)
    } else if (child.type === "export_statement") {
      const edge = readReExport(child, errors)
      if (edge !== null) edges.push(edge)
    }
  }

  // Dynamic imports can appear anywhere in the tree, so scan the whole thing separately.
  walkForDynamicImports(root, edges, errors)

  edges.sort((a, b) => a.line - b.line || compareCodeUnit(a.source, b.source))
  errors.sort((a, b) => a.line - b.line || a.column - b.column)
  return { edges: dedupeEdges(edges), errors }
}

function readImportStatement(node: Node, errors: ParseError[]): ImportEdge[] {
  const requireClause = findChild(node, "import_require_clause")
  if (requireClause !== null) return readRequireClause(node, requireClause, errors)

  const source = readModuleSpecifier(node.childForFieldName("source"), "import", errors)
  if (source === null) return []
  const line = node.startPosition.row + 1
  const clause = node.childForFieldName("import_clause") ?? findChild(node, "import_clause")
  if (clause === null) {
    return [{ source, symbols: "*", line, dynamic: false }]
  }
  const { names, namespaceBinding } = readImportClauseParts(clause)
  const edges: ImportEdge[] = []
  if (names.length > 0) edges.push({ source, symbols: names, line, dynamic: false })
  if (namespaceBinding !== null) {
    edges.push({
      source,
      symbols: "*",
      line,
      dynamic: false,
      namespaceBinding,
    })
  }
  if (edges.length === 0) edges.push({ source, symbols: "*", line, dynamic: false })
  return edges
}

/**
 * `import x = require('./m')` — the CommonJS-interop form, and the ordinary way to import
 * under `.cts` / `.cjs`.
 *
 * The specifier hangs off the `import_require_clause` rather than the statement's `source`
 * field, so the reader above finds nothing and has to be sent here instead.
 *
 * The edge is a **namespace** edge and not a default binding, because `x` names the module
 * object the way `import * as x from './m'` does. Call resolution acts on the difference:
 * the namespace arm of `callgraph.ts` strips the head off `x.foo()` and looks for `foo` in
 * the target file, where a `symbols: ["default as x"]` edge would send it looking for a
 * member `foo` of the target's default export instead — not what `x.foo` names. A wrong edge
 * is worse than the missing one this replaces.
 *
 * `dynamic` is false by definition rather than by consequence: the field means "written as
 * `import()`" (`lang-plugin.md`), and a require-equals is resolved when the module
 * loads. The two loops in `callgraph.ts` that read a file's edges both skip a dynamic one
 * today, so the value is also what keeps this edge visible to call resolution — but that is
 * what the value buys, not what decides it.
 *
 * A clause with no binding is not something the grammar produces from valid source, and the
 * wildcard edge it falls back to still records the dependency — which is the half of the
 * edge no binding is needed to state.
 */
function readRequireClause(statement: Node, clause: Node, errors: ParseError[]): ImportEdge[] {
  if (clause.hasError) return []
  const source = readModuleSpecifier(findChild(clause, "string"), "import", errors)
  if (source === null) return []
  const line = statement.startPosition.row + 1
  const binding = findChild(clause, "identifier")
  if (binding === null) return [{ source, symbols: "*", line, dynamic: false }]
  return [{ source, symbols: "*", line, dynamic: false, namespaceBinding: binding.text }]
}

function readImportClauseParts(clause: Node): {
  names: string[]
  namespaceBinding: string | null
} {
  const names: string[] = []
  let namespaceBinding: string | null = null
  for (const child of clause.namedChildren) {
    if (child === null) continue
    switch (child.type) {
      case "namespace_import": {
        const alias = findChild(child, "identifier")
        if (alias !== null) namespaceBinding = alias.text
        break
      }
      case "identifier":
        // Default import binding: `import Foo from './x'` binds the module's `default` export
        // to `Foo`, so it is written as `{ default as Foo }` would be. A bare `Foo` is what
        // `import { Foo }` produces, and a resolver reading it would look up the module's named
        // `Foo` instead (call-resolution.md §4.4).
        names.push(`${DEFAULT_EXPORT_NAME} as ${child.text}`)
        break
      case "named_imports":
        for (const spec of child.namedChildren) {
          if (spec === null || spec.type !== "import_specifier") continue
          const exportedName = spec.childForFieldName("name")
          if (exportedName === null || exportedName.type !== "identifier") continue
          const aliasNode = spec.childForFieldName("alias")
          if (aliasNode !== null && aliasNode.type === "identifier") {
            names.push(`${exportedName.text} as ${aliasNode.text}`)
          } else {
            names.push(exportedName.text)
          }
        }
        break
    }
  }
  return { names, namespaceBinding }
}

function readReExport(node: Node, errors: ParseError[]): ImportEdge | null {
  const source = readModuleSpecifier(node.childForFieldName("source"), "re-export", errors)
  if (source === null) return null
  const line = node.startPosition.row + 1

  const namespaceExport = findChild(node, "namespace_export")
  if (namespaceExport !== null) {
    return { source, symbols: "*", line, dynamic: false }
  }

  const clauseNode = findChild(node, "export_clause")
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

function walkForDynamicImports(root: Node, edges: ImportEdge[], errors: ParseError[]): void {
  for (const node of walkDescendants(root)) {
    const masked = node.type === "identifier" ? maskedImportSpecifier(node) : undefined
    if (masked !== undefined) {
      edges.push({ source: masked, symbols: "*", line: node.startPosition.row + 1, dynamic: true })
    }
    if (node.type !== "call_expression") continue
    const callee = node.childForFieldName("function")
    if (callee === null || callee.type !== "import") continue
    const args = node.childForFieldName("arguments")
    const specifier =
      args !== null
        ? readModuleSpecifier(firstNonCommentChild(args), "dynamic import", errors)
        : null
    if (specifier === null) continue
    edges.push({ source: specifier, symbols: "*", line: node.startPosition.row + 1, dynamic: true })
  }
}

/**
 * Read the module specifier `site` names, or `null` when there is none to use.
 *
 * The two ways there can be none are kept apart, because only one of them is the author's
 * doing.
 *
 * - `readStaticString` answering `null` means the node was not a literal the reader can
 *   evaluate — a computed specifier (`import(p)`, `import("" + x)`, a template with a
 *   substitution in it, whose fragments joined would answer `"./"` for `` `./${p}` ``, an edge
 *   to a module the author never named), or a shape this reader does not model. There is
 *   nothing to report: the author wrote something valid that static analysis cannot follow.
 *   A `string` and a substitution-free `` `template` `` are one specifier written with
 *   different quotes (LP26j), and both are read.
 * - A literal that *is* there and is empty is something someone typed, and it names no
 *   module. `ImportEdge.source` is a non-empty specifier (`lang-plugin.md`) and the
 *   shared guards in `@aburi/plugin-registry/plugin-input` throw on one that is not, so no
 *   edge can carry it.
 *
 * Collapsing the two into one silent `null` is what this split exists to prevent — an edge
 * withdrawn without a word leaves the file looking as though the import were never written.
 * The empty case goes out as a recoverable parse error instead. That keeps the file: what
 * withdraws one is a parse that returned no tree at all (`scan/pipeline.ts` checks
 * `tree === null`), which is not this.
 *
 * The test is emptiness, not blankness: `" "` is a module name that will not resolve, which
 * is the type checker's business rather than this reader's.
 *
 * A partial read is kept: `"./a\uZZZZb"` comes back as `./a`, the parser's own syntax error
 * accounting for the rest. The fallback to source text (`decodeStringLiteralOrRaw`) is what
 * keeps a literal whose contents are entirely an ERROR out of the empty-specifier diagnostic —
 * a third complaint claiming the author wrote no module name, when they did. A literal that is
 * only a line continuation is empty and whole, and does reach that diagnostic.
 */
function readModuleSpecifier(
  node: Node | null,
  site: ImportSite,
  errors: ParseError[],
): string | null {
  if (node === null) return null
  const specifier = readStaticString(node)
  if (specifier === null) return null
  if (specifier.length > 0) return specifier
  errors.push({
    message: `empty module specifier: this ${site} names no module — write one, or remove the ${site}`,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    recoverable: true,
  })
  return null
}

type ImportSite = "import" | "re-export" | "dynamic import"

/**
 * Dedupe on the semantic identity of an edge: same source at the same line with the same
 * shape of symbols (as an unordered set — `[A, B]` and `[B, A]` are the same import even
 * if the user rearranged the specifiers) and the same dynamic flag. Using a sorted list
 * inside the key keeps that invariant order-insensitive.
 */
function dedupeEdges(edges: readonly ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>()
  const out: ImportEdge[] = []
  for (const edge of edges) {
    const symbolsKey =
      edge.symbols === "*" ? '"*"' : JSON.stringify([...edge.symbols].sort(compareCodeUnit))
    const key = `${edge.line}\t${edge.source}\t${edge.dynamic}\t${symbolsKey}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}
