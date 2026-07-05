import { describe, expect, it } from "vitest"
import {
  isPrismaReadMethod,
  isPrismaTransactionMethod,
  isPrismaWriteMethod,
  PRISMA_READ_METHODS,
  PRISMA_TRANSACTION_METHOD,
  PRISMA_WRITE_METHODS,
} from "../src/index"

describe("Prisma method vocabulary", () => {
  it("exposes every documented delegate read method", () => {
    for (const m of [
      "findUnique",
      "findUniqueOrThrow",
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "count",
      "aggregate",
      "groupBy",
    ] as const) {
      expect(PRISMA_READ_METHODS.has(m)).toBe(true)
      expect(isPrismaReadMethod(m)).toBe(true)
    }
  })

  it("exposes every documented delegate write method", () => {
    for (const m of [
      "create",
      "createMany",
      "createManyAndReturn",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "upsert",
      "delete",
      "deleteMany",
    ] as const) {
      expect(PRISMA_WRITE_METHODS.has(m)).toBe(true)
      expect(isPrismaWriteMethod(m)).toBe(true)
    }
  })

  it("keeps the read and write sets disjoint", () => {
    for (const m of PRISMA_READ_METHODS) {
      expect(PRISMA_WRITE_METHODS.has(m as never)).toBe(false)
    }
  })

  it("recognizes the transaction sentinel and rejects imposters", () => {
    expect(isPrismaTransactionMethod(PRISMA_TRANSACTION_METHOD)).toBe(true)
    expect(isPrismaTransactionMethod("transaction")).toBe(false)
    expect(isPrismaTransactionMethod("$transactional")).toBe(false)
  })

  it("rejects unrelated method names for both sets", () => {
    const untypedRead = PRISMA_READ_METHODS as ReadonlySet<string>
    const untypedWrite = PRISMA_WRITE_METHODS as ReadonlySet<string>
    for (const m of ["executeRaw", "queryRaw", "findMayn", "createOrUpdate"]) {
      expect(untypedRead.has(m)).toBe(false)
      expect(untypedWrite.has(m)).toBe(false)
    }
  })
})
