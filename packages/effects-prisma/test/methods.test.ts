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
  it.each([
    [
      "read",
      PRISMA_READ_METHODS,
      isPrismaReadMethod,
      [
        "findUnique",
        "findUniqueOrThrow",
        "findFirst",
        "findFirstOrThrow",
        "findMany",
        "count",
        "aggregate",
        "groupBy",
      ],
    ],
    [
      "write",
      PRISMA_WRITE_METHODS,
      isPrismaWriteMethod,
      [
        "create",
        "createMany",
        "createManyAndReturn",
        "update",
        "updateMany",
        "updateManyAndReturn",
        "upsert",
        "delete",
        "deleteMany",
      ],
    ],
  ] as const)("lists exactly the delegate %s methods, and its guard accepts each", (_family, set, guard, members) => {
    expect([...set]).toEqual(members)
    for (const method of members) expect(guard(method)).toBe(true)
  })

  it("recognizes $transaction alone as the transaction method", () => {
    expect(PRISMA_TRANSACTION_METHOD).toBe("$transaction")
    expect(isPrismaTransactionMethod("$transaction")).toBe(true)
    expect(isPrismaTransactionMethod("transaction")).toBe(false)
    expect(isPrismaTransactionMethod("$transactional")).toBe(false)
  })
})
