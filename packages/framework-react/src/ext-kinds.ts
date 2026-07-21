/**
 * The seven `framework:react:*` extKinds this plugin owns. Kept as a tuple with
 * `as const` so the derived `ReactExtKind` union is a set of literal string types — a
 * typo in the manifest or classify.ts is a compile-time error, not a runtime `extKind`
 * mismatch caught only when the vocab registry rejects the classification.
 *
 * `REACT_EXT_KIND_SET` is the runtime view (used by tests / consumers that want to
 * validate a raw string against the union without a type assertion).
 */
export const REACT_EXT_KINDS = [
  "framework:react:component",
  "framework:react:hook",
  "framework:react:context",
  "framework:react:forward-ref",
  "framework:react:memo",
  "framework:react:provider",
  "framework:react:hoc",
] as const

export type ReactExtKind = (typeof REACT_EXT_KINDS)[number]

export const REACT_EXT_KIND_SET: ReadonlySet<ReactExtKind> = new Set(REACT_EXT_KINDS)

export function isReactExtKind(value: string): value is ReactExtKind {
  return (REACT_EXT_KIND_SET as ReadonlySet<string>).has(value)
}
