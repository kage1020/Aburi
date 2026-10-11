import { visit } from "jsonc-parser"

const PROTOTYPE_KEY = "__proto__"

export const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false } as const

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
