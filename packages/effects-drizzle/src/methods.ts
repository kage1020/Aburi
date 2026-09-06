/**
 * Drizzle ORM method vocabulary.
 *
 * Each `_LIST` is the single source of truth — the union type and the runtime `Set` are
 * both derived from it, so extending the vocabulary is a table edit in exactly one
 * place. Extending as Drizzle ships new terminal methods keeps the classifier honest
 * without a code rewrite.
 *
 * Only methods that map cleanly onto core `db.read` / `db.write` / `db.transaction`
 * vocabulary are listed. Chained builder steps (`.from`, `.where`, `.set`, `.values`,
 * `.returning`, `.orderBy`, `.limit`, `.leftJoin`, ...) are deliberately NOT in the
 * vocab — they surface as internal segments in the classifier's fluent-chain reject
 * pass so exactly one classification is emitted per query. Raw SQL (`.execute()`) is
 * also excluded because a raw statement can be either a read or a write and static
 * disambiguation would require SQL parsing.
 */
const DRIZZLE_READ_METHODS_LIST = ["select", "selectDistinct", "selectDistinctOn"] as const

const DRIZZLE_WRITE_METHODS_LIST = ["insert", "update", "delete"] as const

/**
 * `transaction` is the standard interactive-transaction API across every driver.
 * `batch` is the multi-statement batch API on Neon (`drizzle-orm/neon-http` /
 * `drizzle-orm/neon-serverless`) and Cloudflare D1 (`drizzle-orm/d1`); it maps to
 * `db.transaction` because it executes multiple statements atomically. `batch` is a
 * method on the driver-specific database instance, not a separate subpath import.
 */
const DRIZZLE_TRANSACTION_METHODS_LIST = ["transaction", "batch"] as const

/**
 * Relational query API terminals: `db.query.<table>.findMany` / `findFirst`.
 * Drizzle does NOT expose `findUnique` (that is Prisma vocabulary) — omit it.
 */
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

/**
 * The most arguments each recognized terminal takes, for the terminals that take more than
 * one. Everything else takes at most one — an optional projection for `select`, a table
 * reference for `insert` / `update` / `delete`, an optional options object for the
 * relational query terminals, a statement array for `batch`.
 *
 * Two exceptions, both from the library's own signatures: Postgres'
 * `selectDistinctOn(columns, projection)` and `transaction(callback, config)`. A flat "one
 * argument" rule would read both as some other API, so the exceptions live next to the
 * vocabulary that defines them rather than as magic numbers at the call site.
 *
 * Keys are typed against the vocabulary unions, so renaming or dropping a terminal breaks
 * the build instead of leaving an arity exception that silently matches nothing.
 */
const DRIZZLE_MULTI_ARGUMENT_TERMINALS: ReadonlyMap<
  DrizzleReadMethod | DrizzleTransactionMethod,
  number
> = new Map<DrizzleReadMethod | DrizzleTransactionMethod, number>([
  ["selectDistinctOn", 2],
  ["transaction", 2],
])

/** The most arguments `method` takes before the call stops looking like Drizzle's own API. */
export function maxArgumentsFor(method: string): number {
  return (
    (DRIZZLE_MULTI_ARGUMENT_TERMINALS as ReadonlyMap<string, number>).get(method) ??
    DEFAULT_MAX_ARGUMENTS
  )
}

const DEFAULT_MAX_ARGUMENTS = 1

/**
 * The set of verbs that anchor a fluent chain at its root. A CallCandidate whose target
 * has any of these as an INTERNAL segment (i.e. neither first nor last) is a downstream
 * link of an already-classified chain and must be rejected to preserve the
 * one-classification-per-chain invariant.
 *
 * Internal helper — consumed only by `classifyDrizzleCall` — so it is deliberately kept
 * out of the public barrel export. Widened to `ReadonlySet<string>` at the callsite via
 * a cast because `Set.prototype.has` requires the element type and the callsite passes a
 * generic `string` segment.
 */
export const DRIZZLE_FLUENT_ROOT_METHODS: ReadonlySet<DrizzleReadMethod | DrizzleWriteMethod> =
  new Set<DrizzleReadMethod | DrizzleWriteMethod>([
    ...DRIZZLE_READ_METHODS_LIST,
    ...DRIZZLE_WRITE_METHODS_LIST,
  ])
