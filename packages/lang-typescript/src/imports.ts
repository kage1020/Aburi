import type { ImportEdge, ParseError } from "@aburi/types"
import type { Node, Tree } from "web-tree-sitter"
import { findChild, firstNonCommentChild } from "./ast-helpers"
import { decodeStringLiteral } from "./string-escape"

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
 * Covers the shapes the design contract enumerates:
 *   - Static named / default / mixed:  `import Foo, { A as B, C } from './x'`
 *   - Namespace:                       `import * as Foo from 'z'`
 *   - CommonJS interop:                `import Foo = require('./x')`
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
 * the target file, where a `symbols: ["x"]` edge would send it looking for `x.foo` there —
 * a name the target does not have. A wrong edge is worse than the missing one this replaces.
 *
 * `dynamic` is false by definition rather than by consequence: the field means "written as
 * `import()`" (`lang-plugin.md` §4.2), and a require-equals is resolved when the module
 * loads. The two loops in `callgraph.ts` that read a file's edges both skip a dynamic one
 * today, so the value is also what keeps this edge visible to call resolution — but that is
 * what the value buys, not what decides it.
 *
 * A clause with no binding is not something the grammar produces from valid source, and the
 * wildcard edge it falls back to still records the dependency — which is the half of the
 * edge no binding is needed to state.
 */
function readRequireClause(statement: Node, clause: Node, errors: ParseError[]): ImportEdge[] {
  // The grammar admits nothing but a string literal for the specifier, so a computed
  // argument is a syntax error the parser reports for itself — but error recovery leaves the
  // operand it could read as a direct child of the clause, with the `source` field attached
  // to it. `require("a" + b)` would answer `a`, and `require('./m', 'y')` would answer the
  // second argument. A clause that did not parse is not read at all.
  if (clause.hasError) return []
  const source = readModuleSpecifier(findChild(clause, "string"), "import", errors)
  if (source === null) return []
  const line = statement.startPosition.row + 1
  const binding = findChild(clause, "identifier")
  if (binding === null) return [{ source, symbols: "*", line, dynamic: false }]
  return [{ source, symbols: "*", line, dynamic: false, namespaceBinding: binding.text }]
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
        const alias = findChild(child, "identifier")
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
        // The specifier is the first argument that is not a comment. A magic comment
        // (`import(/* webpackChunkName */ './m')`) is a named node sitting in front of it,
        // and reading child zero unconditionally would hand the reader the comment.
        const specifier =
          args !== null
            ? readModuleSpecifier(firstNonCommentChild(args), "dynamic import", errors)
            : null
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
 * - `readLiteralSpecifier` answering `null` means the node was not a literal the reader can
 *   evaluate — a computed specifier (`import(p)`, `import("" + x)`, a template with a
 *   substitution in it), or a shape this reader does not model. There is nothing to report:
 *   the author wrote something valid that static analysis cannot follow.
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
  const specifier = readLiteralSpecifier(node)
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
 * Read the contents of a specifier written as a literal, without its surrounding quotes.
 *
 * A `string` and a substitution-free `` `template` `` are both accepted, because they are
 * the same specifier written with different quotes: the module a bare template names is
 * fixed at the point it is written. A template *with* a `template_substitution` is not, and
 * is refused — joining its fragments would answer `"./"` for `` `./${p}` ``, an edge to a
 * module the author never named, which is a worse answer than none.
 *
 * Returns `null` for anything else — an identifier, a concatenation. Those are computed
 * specifiers this reader does not follow, and the caller treats them as nothing to say
 * rather than as a fault. An empty literal returns `""`, which is a different answer and is
 * the caller's to judge.
 *
 * **An escape is decoded, not skipped.** What is *read* is a literal's `string_fragment`s and
 * its `escape_sequence`s, both in source order, so `"./a\tb"` comes back as `./a`, a tab, `b`.
 * Dropping the escape used to answer `./ab` — a module that does not exist, indistinguishable
 * in the IR from one that does — and for `"\x2E/e"` it answered `/e`, which fails
 * `isRelativeSpecifier` (neither `./` nor `../`) and sent every call through that binding to
 * the `external` bucket instead of to the sibling file it names.
 *
 * Those are not the only named children a literal can have. An ERROR node is one too, and a
 * specifier keeps what parsed around it: `"./a\uZZZZb"` comes back as `./a`, with the
 * parser's own syntax error accounting for the rest. `decodeStringLiteral` reports the
 * partial read as well, and this caller is the one that does not act on it — a class member's
 * name, which becomes part of a Symbol id, refuses the same read.
 *
 * The quote-stripping fallback below is what a literal reaches when the read came back empty
 * *and* incomplete — a literal whose contents are entirely an ERROR node. Stripping the quotes
 * is what leaves the parser's own syntax error as the only thing said about it; calling it
 * empty as well would be a third diagnostic claiming the author wrote no module name, and they
 * did.
 *
 * Which is why `whole` is read here after all, for the one shape that needs it and no more. An
 * escape can decode to nothing — a line continuation joins two source lines and contributes no
 * character — so a literal that is only one comes back empty and *whole*, and reaches the
 * empty-specifier diagnostic it should. `"\uZZZZ"` comes back empty and not whole, and reaches
 * the fallback. Reading emptiness alone cannot tell those two apart, and sends the second to
 * the diagnostic this paragraph says it avoids.
 */
function readLiteralSpecifier(node: Node): string | null {
  if (node.type === "template_string") {
    if (findChild(node, "template_substitution") !== null) return null
  } else if (node.type !== "string") {
    return null
  }
  const { value, whole } = decodeStringLiteral(node)
  if (whole || value !== "") return value
  const raw = node.text
  if (raw.length >= 2 && /^["'`]/.test(raw)) return raw.slice(1, -1)
  return raw
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
