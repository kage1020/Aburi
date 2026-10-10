import { describe, expect, it } from "vitest"
import {
  DRIZZLE_QUERY_METHODS,
  DRIZZLE_READ_METHODS,
  DRIZZLE_TRANSACTION_METHODS,
  DRIZZLE_WRITE_METHODS,
  isDrizzleQueryMethod,
  isDrizzleReadMethod,
  isDrizzleTransactionMethod,
  isDrizzleWriteMethod,
} from "../src/index"

const FAMILIES = [
  [
    "read",
    DRIZZLE_READ_METHODS,
    isDrizzleReadMethod,
    ["select", "selectDistinct", "selectDistinctOn"],
  ],
  ["write", DRIZZLE_WRITE_METHODS, isDrizzleWriteMethod, ["insert", "update", "delete"]],
  [
    "transaction",
    DRIZZLE_TRANSACTION_METHODS,
    isDrizzleTransactionMethod,
    ["transaction", "batch"],
  ],
  ["relational query", DRIZZLE_QUERY_METHODS, isDrizzleQueryMethod, ["findMany", "findFirst"]],
] as const

describe("Drizzle method vocabulary", () => {
  it.each(
    FAMILIES,
  )("lists exactly the %s terminals, and its guard accepts each", (_family, set, guard, members) => {
    expect([...set]).toEqual(members)
    for (const method of members) expect(guard(method)).toBe(true)
  })

  it.each([
    "from",
    "where",
    "values",
    "returning",
    "execute",
    "findUnique",
  ])("rejects %s in every family", (method) => {
    for (const [, , guard] of FAMILIES) expect(guard(method)).toBe(false)
  })
})
