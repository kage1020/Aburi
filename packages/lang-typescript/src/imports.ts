import type { ImportEdge, ParseError } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"

/**
 * The import sites a file declares, and what was wrong with the ones that could not become
 * edges.
 *
 * The two travel together because an edge withdrawn without a diagnostic is indistinguishable
 * from a file that never had the import — and a specifier the reader refuses is exactly the
 * case where the author needs to hear about it.
 */
export interface ImportExtraction {
  edges: ImportEdge[]
  errors: ParseError[]
}

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

  edges.sort((a, b) => a.line - b.line || cmpString(a.source, b.source))
  // Both lists are put in source order, and for the same reason: the dynamic-import walk is a
  // LIFO stack, so it visits siblings back to front and would otherwise hand a reader on one
  // line three diagnostics counting down the columns.
  errors.sort((a, b) => a.line - b.line || a.column - b.column)
  // Errors are not deduplicated the way edges are. `dedupeEdges` keys on the line among other
  // things, so it only ever collapses two writings on one line — and two broken specifiers on
  // one line are still two places to go and fix.
  return { edges: dedupeEdges(edges), errors }
}

/**
 * `import ... from '...'` — read the module specifier and every imported symbol shape.
 * A single import statement can produce more than one ImportEdge when a namespace binding
 * co-occurs with named or default bindings: keeping both edges preserves the "this module
 * is referenced wholesale" signal (`*`) alongside the concrete bindings (`Foo`, `A`, `B`)
 * that downstream dependency analysis needs.
 *
 * Missing clauses (bare `import './side-effect'`) still produce a `"*"` edge so the
 * dependency relationship is visible in the IR.
 */
function readImportStatement(node: Node, errors: ParseError[]): ImportEdge[] {
  const source = readModuleSpecifier(node.childForFieldName("source"), "import", errors)
  if (source === null) return []
  const line = node.startPosition.row + 1
  const clause = node.childForFieldName("import_clause") ?? findChildByType(node, "import_clause")
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
 * Break an import_clause into its named identifiers and namespace binding.
 * `readImportStatement` turns the pair into one or two edges depending on
 * which shapes are present.
 *
 * Aliased named imports (`{ A as B }`) are emitted as the composite string
 * `"A as B"` so downstream consumers see BOTH the exported name (A — the one
 * that matches the target module's Symbol id) and the local rebind (B — the
 * one the caller writes at the call site). Splitting on ` as ` recovers both
 * halves without a second AST pass. Un-aliased entries stay as the plain
 * exported name.
 *
 * Namespace imports (`* as N`) carry the local binding N on
 * `ImportEdge.namespaceBinding` — recovering it from the module specifier
 * (`./util-helpers` → `helpers`?) is guesswork that fails on every renamed or
 * kebab-cased module.
 */
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
        const alias = findChildByType(child, "identifier")
        if (alias !== null) namespaceBinding = alias.text
        break
      }
      case "identifier":
        // Default import binding: `import Foo from './x'` — the identifier IS the binding
        // name that downstream code will use, so include it verbatim.
        names.push(child.text)
        break
      case "named_imports":
        for (const spec of child.namedChildren) {
          if (spec === null || spec.type !== "import_specifier") continue
          // `{ A }` or `{ A as B }` — grammar exposes both `name` (imported) and `alias`
          // (local). Emit "A as B" when the alias differs; otherwise emit the bare name.
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

/**
 * `export { X } from './y'` — a re-export is functionally a dependency on `./y`, so surface
 * it as a static ImportEdge. `export * from './y'` collapses to `"*"`.
 */
function readReExport(node: Node, errors: ParseError[]): ImportEdge | null {
  const source = readModuleSpecifier(node.childForFieldName("source"), "re-export", errors)
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
function walkForDynamicImports(root: Node, edges: ImportEdge[], errors: ParseError[]): void {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function")
      if (callee !== null && callee.type === "import") {
        const args = node.childForFieldName("arguments")
        const specifier =
          args !== null ? readModuleSpecifier(args.namedChild(0), "dynamic import", errors) : null
        if (specifier !== null) {
          edges.push({
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
 * Read the module specifier `site` names, or `null` when there is none to use.
 *
 * The two ways there can be none are kept apart, because only one of them is the author's
 * doing.
 *
 * - `readStringLiteral` answering `null` means the node was not a string literal — a
 *   computed specifier (`import(p)`, `import("" + x)`), or a shape this reader does not
 *   model. There is nothing to report: the author wrote something valid that static analysis
 *   cannot follow.
 * - A literal that *is* there and is empty is something someone typed, and it names no
 *   module. `ImportEdge.source` is a non-empty specifier (`lang-plugin.md` §4.4) and the
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
 */
function readModuleSpecifier(
  node: Node | null,
  site: ImportSite,
  errors: ParseError[],
): string | null {
  if (node === null) return null
  const specifier = readStringLiteral(node)
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

/**
 * Which construct the specifier belonged to, so the diagnostic names what the reader is
 * looking at. `export * from ""` is not an import, and being told it is sends the author
 * looking at the wrong line.
 */
type ImportSite = "import" | "re-export" | "dynamic import"

/**
 * Read a `string` node's contents without the surrounding quotes.
 *
 * Returns `null` for a node that is not a `string` — a template literal, an identifier, a
 * concatenation. Those are computed specifiers this reader does not follow, and the caller
 * treats them as nothing to say rather than as a fault. An empty literal returns `""`, which
 * is a different answer and is the caller's to judge.
 *
 * **The result is not faithful to the source.** A `string` node's named children are its
 * `string_fragment`s and its `escape_sequence`s, and only the fragments are read, so an
 * escape is deleted rather than decoded: `"./ab"` comes back as `./a`, and `"./e"`
 * as `/e` — which stops being relative and is then resolved as a bare package. That is a
 * separate defect from the one the caller guards, and fixing it means decoding the escapes
 * rather than skipping them.
 *
 * It does not reach the caller's gate, though, and the reason is worth stating because it is
 * not obvious: a literal made only of escapes has zero fragments, so it falls to the
 * quote-stripping fallback and comes back non-empty (`"\n"` → the two characters `\` and
 * `n`). Only a genuinely empty literal reaches the empty branch.
 */
function readStringLiteral(node: Node): string | null {
  if (node.type !== "string") return null
  const parts: string[] = []
  for (const child of node.namedChildren) {
    if (child === null) continue
    if (child.type === "string_fragment") parts.push(child.text)
  }
  if (parts.length > 0) return parts.join("")
  // No fragments: either an empty literal, or one made entirely of escape sequences. Strip
  // the quotes off the raw text, which distinguishes them — the first is empty, the second
  // is not.
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
      edge.symbols === "*"
        ? '"*"'
        : JSON.stringify([...edge.symbols].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    const key = `${edge.line}\t${edge.source}\t${edge.dynamic}\t${symbolsKey}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
