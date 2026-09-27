import { type JSONPath, type ParseOptions, visit } from "jsonc-parser"

const PROTOTYPE_KEY = "__proto__"

/** Where `findRepeatedKey` stopped: the key, its owner's JSON path, and 1-based position. */
export interface RepeatedKey {
  key: string
  path: readonly (string | number)[]
  line: number
  column: number
}

/**
 * The first key a JSONC text names twice in one object, at any depth, or `null`. Parsing keeps
 * the last and says nothing, so `{ "ignore": ["a/**"], "ignore": ["b/**"] }` would drop `a/**`
 * with no sign the file asked for it.
 *
 * `__proto__` counts the first time: the parser assigns it, which replaces the object's
 * prototype rather than adding a key, so a schema never sees what it holds while a property
 * read still finds it.
 *
 * Pass the options the text was parsed with. `parse` is `visit` with an error-collecting
 * visitor, so this walk sees what `parse` accepted only while the two agree.
 */
export function findRepeatedKey(text: string, options: ParseOptions): RepeatedKey | null {
  const open: Set<string>[] = []
  // Widened by the cast: the callbacks assign it, which narrowing after `visit` cannot see.
  let found = null as RepeatedKey | null
  visit(
    text,
    {
      // Returning `false` here would silence every callback below this object.
      onObjectBegin: () => {
        open.push(new Set())
      },
      onObjectEnd: () => {
        open.pop()
      },
      onObjectProperty: (key, _offset, _length, line, column, pathOf) => {
        const keys = open.at(-1)
        if (found !== null || keys === undefined) return
        if (keys.has(key) || key === PROTOTYPE_KEY) {
          const path: JSONPath = pathOf()
          found = { key, path, line: line + 1, column: column + 1 }
        }
        keys.add(key)
      },
    },
    options,
  )
  return found
}

/** What `found` did, worded to follow "Config at <path>" or "Plugin manifest at <path>". */
export function describeRepeatedKey(found: RepeatedKey): string {
  const owner = found.path.length === 0 ? "the top-level object" : `/${found.path.join("/")}`
  const at = `line ${found.line}, column ${found.column}`
  if (found.key !== PROTOTYPE_KEY) return `names "${found.key}" twice in ${owner} (again at ${at})`
  return (
    `names "${found.key}" as a key in ${owner} (at ${at}); it replaces the object's ` +
    "prototype instead of adding a key, so the schema cannot see it"
  )
}
