import { visit } from "jsonc-parser"

const PROTOTYPE_KEY = "__proto__"

/**
 * How every JSONC text in Aburi is read: comments and trailing commas allowed. `scanKeys` reads
 * with these, so a caller that parses with them sees the text the scan saw.
 */
export const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const

/**
 * A key the parsed value does not faithfully carry: one named twice in an object, or `__proto__`.
 * `line` and `column` are 1-based; with `offset` and `length` they point at the second occurrence
 * of a repeated key, and at the only one of a prototype key. `owner` is the JSON path of the
 * object that holds it.
 */
export interface RepeatedKey {
  readonly kind: "repeated" | "prototype-key"
  readonly key: string
  readonly owner: readonly (string | number)[]
  readonly line: number
  readonly column: number
  readonly offset: number
  readonly length: number
}

/** What `scanKeys` found: nothing, a text it could not read, or the first conflicting key. */
export type KeyScan = { readonly kind: "clean" } | { readonly kind: "unreadable" } | RepeatedKey

/**
 * The first key a JSONC text names twice in one object, at any depth. Parsing keeps the last and
 * says nothing, so `{ "name": "a", "name": "b" }` reads as `b` with no sign the file said `a`.
 *
 * `__proto__` counts the first time: `jsonc-parser` assigns it rather than defining it, so it
 * never becomes a key the schema can see.
 *
 * A text that does not parse under `JSONC_PARSE_OPTIONS` is `unreadable` rather than clean, since
 * positions mean nothing until it does.
 */
export function scanKeys(text: string): KeyScan {
  const open: Set<string>[] = []
  let unreadable = false
  let found: RepeatedKey | null = null
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
      onObjectProperty: (key, offset, length, line, column, pathOf) => {
        const keys = open.at(-1)
        if (keys === undefined) {
          throw new Error(`jsonc invariant violation: property "${key}" outside any object`)
        }
        if (found === null && (keys.has(key) || key === PROTOTYPE_KEY)) {
          found = {
            kind: keys.has(key) ? "repeated" : "prototype-key",
            key,
            owner: pathOf(),
            line: line + 1,
            column: column + 1,
            offset,
            length,
          }
        }
        keys.add(key)
      },
      onError: () => {
        unreadable = true
      },
    },
    JSONC_PARSE_OPTIONS,
  )
  if (unreadable) return { kind: "unreadable" }
  return found ?? { kind: "clean" }
}

/** The sentence that refuses `found`, with `subject` naming the file (`Config at aburi.json`). */
export function describeRepeatedKey(found: RepeatedKey, subject: string): string {
  const owner = found.owner.length === 0 ? "the top-level object" : pointer(found.owner)
  const at = `line ${found.line}, column ${found.column}`
  if (found.kind === "repeated") {
    return `${subject} names "${found.key}" twice in ${owner} (again at ${at})`
  }
  return (
    `${subject} names "${found.key}" as a key in ${owner} (at ${at}); the parser assigns it ` +
    "instead of defining it, so it never becomes a key the schema can see"
  )
}

/** RFC 6901, the form ajv's `instancePath` takes in the neighbouring schema messages. */
function pointer(path: readonly (string | number)[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("")
}
