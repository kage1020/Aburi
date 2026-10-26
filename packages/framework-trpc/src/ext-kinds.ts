export const TRPC_EXT_KINDS = [
  "framework:trpc:instance",
  "framework:trpc:router",
  "framework:trpc:procedure",
  "framework:trpc:base-procedure",
  "framework:trpc:middleware",
] as const

export type TrpcExtKind = (typeof TRPC_EXT_KINDS)[number]

export const TRPC_DERIVED_BY_PREFIX = "framework:trpc"
