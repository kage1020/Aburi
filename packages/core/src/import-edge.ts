/**
 * Readers for the wire format of `ImportEdge.symbols`.
 *
 * The language plugin emits one entry per named import, verbatim as it appeared in source:
 * `"X"` for a plain import and `"X as Y"` for a renamed one. Two independent consumers —
 * the call-graph resolver and the framework plugins' decorator matching — have to recover
 * the same two halves from it, so the parser lives here rather than in either of them.
 */

/**
 * The two names a single `ImportEdge.symbols` entry carries.
 *
 * `imported` is the name the source module exports; `local` is the binding the importing
 * file writes. They are equal for an unaliased import, and for a default import
 * (`import Foo from './x'`), which the wire format cannot distinguish from a named one —
 * both are a bare identifier.
 */
export interface ImportBinding {
  imported: string
  local: string
}

/**
 * Split one `ImportEdge.symbols` entry into its exported and local names.
 *
 * `"X as Y"` → `{ imported: "X", local: "Y" }`; `"X"` → `{ imported: "X", local: "X" }`.
 * Surrounding whitespace is trimmed, because the separator is matched on the first ` as `
 * rather than by re-tokenizing, and a plugin is free to have written the entry with the
 * spacing of the source.
 */
export function splitAliasedImportName(raw: string): ImportBinding {
  const marker = " as "
  const idx = raw.indexOf(marker)
  if (idx < 0) {
    const only = raw.trim()
    return { imported: only, local: only }
  }
  const imported = raw.slice(0, idx).trim()
  const local = raw.slice(idx + marker.length).trim()
  return { imported, local }
}
