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

const PRISMA_RAW_QUERY_METHODS_LIST = [
  "$queryRaw",
  "$queryRawUnsafe",
  "$queryRawTyped",
  "$executeRaw",
  "$executeRawUnsafe",
  "$runCommandRaw",
] as const

export type PrismaRawQueryMethod = (typeof PRISMA_RAW_QUERY_METHODS_LIST)[number]

export const PRISMA_RAW_QUERY_METHODS: ReadonlySet<PrismaRawQueryMethod> = new Set(
  PRISMA_RAW_QUERY_METHODS_LIST,
)

export function isPrismaRawQueryMethod(name: string): name is PrismaRawQueryMethod {
  return (PRISMA_RAW_QUERY_METHODS as ReadonlySet<string>).has(name)
}
