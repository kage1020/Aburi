const DRIZZLE_READ_METHODS_LIST = ["select", "selectDistinct", "selectDistinctOn"] as const

const DRIZZLE_WRITE_METHODS_LIST = ["insert", "update", "delete"] as const

const DRIZZLE_TRANSACTION_METHODS_LIST = ["transaction", "batch"] as const

/** Relational query API terminals (`db.query.<table>.findMany`). No `findUnique` — that is Prisma. */
const DRIZZLE_QUERY_METHODS_LIST = ["findMany", "findFirst"] as const

export type DrizzleReadMethod = (typeof DRIZZLE_READ_METHODS_LIST)[number]
export type DrizzleWriteMethod = (typeof DRIZZLE_WRITE_METHODS_LIST)[number]
export type DrizzleTransactionMethod = (typeof DRIZZLE_TRANSACTION_METHODS_LIST)[number]
export type DrizzleQueryMethod = (typeof DRIZZLE_QUERY_METHODS_LIST)[number]

export const DRIZZLE_READ_METHODS: ReadonlySet<DrizzleReadMethod> = new Set(
  DRIZZLE_READ_METHODS_LIST,
)
export const DRIZZLE_WRITE_METHODS: ReadonlySet<DrizzleWriteMethod> = new Set(
  DRIZZLE_WRITE_METHODS_LIST,
)
export const DRIZZLE_TRANSACTION_METHODS: ReadonlySet<DrizzleTransactionMethod> = new Set(
  DRIZZLE_TRANSACTION_METHODS_LIST,
)
export const DRIZZLE_QUERY_METHODS: ReadonlySet<DrizzleQueryMethod> = new Set(
  DRIZZLE_QUERY_METHODS_LIST,
)

export function isDrizzleReadMethod(name: string): name is DrizzleReadMethod {
  return (DRIZZLE_READ_METHODS as ReadonlySet<string>).has(name)
}

export function isDrizzleWriteMethod(name: string): name is DrizzleWriteMethod {
  return (DRIZZLE_WRITE_METHODS as ReadonlySet<string>).has(name)
}

export function isDrizzleTransactionMethod(name: string): name is DrizzleTransactionMethod {
  return (DRIZZLE_TRANSACTION_METHODS as ReadonlySet<string>).has(name)
}

export function isDrizzleQueryMethod(name: string): name is DrizzleQueryMethod {
  return (DRIZZLE_QUERY_METHODS as ReadonlySet<string>).has(name)
}

const DRIZZLE_MULTI_ARGUMENT_TERMINALS: ReadonlyMap<
  DrizzleReadMethod | DrizzleTransactionMethod,
  number
> = new Map<DrizzleReadMethod | DrizzleTransactionMethod, number>([
  ["selectDistinctOn", 2],
  ["transaction", 2],
])

const DEFAULT_MAX_ARGUMENTS = 1

/** The most arguments `method` takes before the call stops looking like Drizzle's own API. */
export function maxArgumentsFor(method: string): number {
  return (
    (DRIZZLE_MULTI_ARGUMENT_TERMINALS as ReadonlyMap<string, number>).get(method) ??
    DEFAULT_MAX_ARGUMENTS
  )
}

const DRIZZLE_REQUIRED_ARGUMENT_TERMINALS: ReadonlySet<
  DrizzleWriteMethod | DrizzleTransactionMethod
> = new Set<DrizzleWriteMethod | DrizzleTransactionMethod>([
  ...DRIZZLE_WRITE_METHODS_LIST,
  ...DRIZZLE_TRANSACTION_METHODS_LIST,
])

/** The fewest arguments `method` takes as Drizzle's own API: one for those terminals, else 0. */
export function minArgumentsFor(method: string): number {
  return (DRIZZLE_REQUIRED_ARGUMENT_TERMINALS as ReadonlySet<string>).has(method) ? 1 : 0
}

export const DRIZZLE_FLUENT_ROOT_METHODS: ReadonlySet<DrizzleReadMethod | DrizzleWriteMethod> =
  new Set<DrizzleReadMethod | DrizzleWriteMethod>([
    ...DRIZZLE_READ_METHODS_LIST,
    ...DRIZZLE_WRITE_METHODS_LIST,
  ])
