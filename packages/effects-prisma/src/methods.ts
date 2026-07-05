/**
 * Prisma model delegate method vocabulary.
 *
 * The set is bound to the Prisma Client public delegate surface — every method here
 * lives on `prisma.<model>` and returns a Promise for a database round-trip. Extending
 * the set as Prisma releases new delegate methods is a table edit here, not a classifier
 * rewrite.
 *
 * Only methods that map cleanly onto core `db.read` / `db.write` vocabulary are listed.
 * Delegate helpers whose semantics do not match (e.g. `fields` metadata accessors) stay
 * out — the plugin returns `null` for them so downstream plugins get a chance.
 *
 * `readonly` literal sets so `.has(x)` narrows `x` inside the truthy branch and the
 * accepted method names are visible in tooling / hover.
 */
export type PrismaReadMethod =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy"

export type PrismaWriteMethod =
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "updateManyAndReturn"
  | "upsert"
  | "delete"
  | "deleteMany"

/** Top-level client method: `prisma.$transaction(...)`. Not nested under a model. */
export type PrismaTransactionMethod = "$transaction"

export const PRISMA_READ_METHODS: ReadonlySet<PrismaReadMethod> = new Set<PrismaReadMethod>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
])

export const PRISMA_WRITE_METHODS: ReadonlySet<PrismaWriteMethod> = new Set<PrismaWriteMethod>([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
])

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
