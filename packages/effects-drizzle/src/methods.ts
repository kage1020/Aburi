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
 * `batch` is the multi-statement batch API on Neon / Cloudflare D1 / drizzle-orm/batch;
 * it maps to `db.transaction` because it executes multiple statements atomically.
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
 * The set of verbs that anchor a fluent chain at its root. A CallCandidate whose target
 * has any of these as an INTERNAL segment (i.e. neither first nor last) is a downstream
 * link of an already-classified chain and must be rejected to preserve the
 * one-classification-per-chain invariant.
 *
 * `transaction` / `batch` are NOT here — they take a callback, not a chain, so their
 * target never appears as an internal segment of another root call.
 * Query API verbs (`findMany` / `findFirst`) are NOT here — the relational query API
 * returns a Promise directly with no fluent chain, so no internal-segment collision is
 * possible.
 */
export const DRIZZLE_FLUENT_ROOT_METHODS: ReadonlySet<string> = new Set<string>([
  ...DRIZZLE_READ_METHODS_LIST,
  ...DRIZZLE_WRITE_METHODS_LIST,
])
