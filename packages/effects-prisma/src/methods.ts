/**
 * Prisma model delegate method vocabulary.
 *
 * Each `_LIST` is the single source of truth — the union type and the runtime `Set` are
 * both derived from it, so extending the vocabulary is a table edit in exactly one
 * place. Extending as Prisma ships new delegate methods keeps the classifier honest
 * without a code rewrite.
 *
 * Only methods that map cleanly onto core `db.read` / `db.write` vocabulary are listed.
 * Delegate helpers whose semantics do not match (metadata accessors, raw SQL escapes,
 * connection lifecycle) stay out — the plugin returns `null` for them so downstream
 * effect plugins get a chance.
 */
const PRISMA_READ_METHODS_LIST = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
] as const

const PRISMA_WRITE_METHODS_LIST = [
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
] as const

export type PrismaReadMethod = (typeof PRISMA_READ_METHODS_LIST)[number]
export type PrismaWriteMethod = (typeof PRISMA_WRITE_METHODS_LIST)[number]

/** Top-level client method: `prisma.$transaction(...)`. Not nested under a model. */
export type PrismaTransactionMethod = "$transaction"

export const PRISMA_READ_METHODS: ReadonlySet<PrismaReadMethod> = new Set(PRISMA_READ_METHODS_LIST)
export const PRISMA_WRITE_METHODS: ReadonlySet<PrismaWriteMethod> = new Set(
  PRISMA_WRITE_METHODS_LIST,
)
export const PRISMA_TRANSACTION_METHOD: PrismaTransactionMethod = "$transaction"

export function isPrismaReadMethod(name: string): name is PrismaReadMethod {
  return (PRISMA_READ_METHODS as ReadonlySet<string>).has(name)
}

export function isPrismaWriteMethod(name: string): name is PrismaWriteMethod {
  return (PRISMA_WRITE_METHODS as ReadonlySet<string>).has(name)
}

export function isPrismaTransactionMethod(name: string): name is PrismaTransactionMethod {
  return name === PRISMA_TRANSACTION_METHOD
}
