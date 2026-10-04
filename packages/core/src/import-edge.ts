/**
 * Readers for the wire format of `ImportEdge.symbols`.
 *
 * The language plugin emits one entry per binding an import clause makes: `"X"` for a plain
 * named import, `"X as Y"` for a renamed one, and `"default as Y"` for a default import. The
 * first two quote the source; the third is composed, since `import Y from './x'` writes no
 * ` as `. Two independent consumers — the call-graph resolver and the framework plugins'
 * decorator matching — have to recover the same two halves from it, so the parser lives here
 * rather than in either of them.
 */

/**
 * The name a module's default export goes by in an import, and so the `imported` half of
 * every default import's entry: `import Foo from './x'` arrives as `"default as Foo"`, the
 * way `import { default as Foo } from './x'` is written. Not to be confused with
 * `DEFAULT_EXPORT_QNAME`, the qualified name of the Symbol an anonymous default export gets.
 */
export const DEFAULT_EXPORT_NAME = "default"

/**
 * The two names a single `ImportEdge.symbols` entry carries.
 *
 * `imported` is the name the source module exports it under; `local` is the binding the
 * importing file writes. They are equal for an unaliased import. A default import
 * (`import Foo from './x'`) arrives as `"default as Foo"`, so `imported` is `"default"`: the
 * module exports `default`, not `Foo`, and a consumer matching a vocabulary table has to
 * decide what a default import means to it.
 *
 * Nothing checks that a language plugin spells a default import that way. One that emits a
 * bare `"Foo"` produces an entry no reader can tell from `import { Foo }`: call resolution
 * looks for a named `Foo` in the module and links to it when there is one, whatever the
 * default export is, and nothing reports that anything was misread (`lang-plugin.md` LP24a
 * puts the spelling on the plugin).
 *
 * Neither half is guaranteed non-empty: `" as Y"` and `"X as "` are not shapes a language
 * plugin should emit, and this parser reports them rather than repairing them. A consumer
 * that looks names up in a table wants `assertImportBinding` from
 * `@aburi/plugin-registry/plugin-input`, because an empty half misses every entry silently.
 */
export interface ImportBinding {
  imported: string
  local: string
}

/**
 * Split one `ImportEdge.symbols` entry into its exported and local names.
 *
 * `"X as Y"` → `{ imported: "X", local: "Y" }`; `"X"` → `{ imported: "X", local: "X" }`.
 * Surrounding whitespace is trimmed on both branches, because a plugin is free to have
 * written the entry with the spacing of the source and the separator is matched on the first
 * ` as ` rather than by re-tokenizing.
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
