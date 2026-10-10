export const EXPRESS_EXT_KINDS = [
  "framework:express:router",
  "framework:express:route",
  "framework:express:middleware",
  "framework:express:error-middleware",
  "framework:express:mount",
] as const

export type ExpressExtKind = (typeof EXPRESS_EXT_KINDS)[number]

export const EXPRESS_EXT_KIND_SET: ReadonlySet<ExpressExtKind> = new Set(EXPRESS_EXT_KINDS)

export function isExpressExtKind(value: string): value is ExpressExtKind {
  return (EXPRESS_EXT_KIND_SET as ReadonlySet<string>).has(value)
}

export const EXPRESS_DERIVED_BY_PREFIX = "framework:express"
