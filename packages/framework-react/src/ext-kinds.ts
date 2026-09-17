/** The `framework:react:*` extKinds this plugin owns; `REACT_EXT_KIND_SET` is the same list as a runtime set. */
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

export const REACT_DERIVED_BY_PREFIX = "framework:react"
