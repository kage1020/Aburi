import { describe, expect, it } from "vitest"
import {
  DRIZZLE_FLUENT_ROOT_METHODS,
  DRIZZLE_QUERY_METHODS,
  DRIZZLE_READ_METHODS,
  DRIZZLE_TRANSACTION_METHODS,
  DRIZZLE_WRITE_METHODS,
  isDrizzleQueryMethod,
  isDrizzleReadMethod,
  isDrizzleTransactionMethod,
  isDrizzleWriteMethod,
} from "../src/index"

describe("Drizzle method vocabulary", () => {
  it("exposes every documented read terminal (select variants)", () => {
    for (const m of ["select", "selectDistinct", "selectDistinctOn"] as const) {
      expect(DRIZZLE_READ_METHODS.has(m)).toBe(true)
      expect(isDrizzleReadMethod(m)).toBe(true)
    }
  })

  it("exposes every documented write terminal (insert / update / delete)", () => {
    for (const m of ["insert", "update", "delete"] as const) {
      expect(DRIZZLE_WRITE_METHODS.has(m)).toBe(true)
      expect(isDrizzleWriteMethod(m)).toBe(true)
    }
  })

  it("recognizes transaction and batch as transaction terminals", () => {
    expect(isDrizzleTransactionMethod("transaction")).toBe(true)
    expect(isDrizzleTransactionMethod("batch")).toBe(true)
    expect(DRIZZLE_TRANSACTION_METHODS.has("transaction")).toBe(true)
    expect(DRIZZLE_TRANSACTION_METHODS.has("batch")).toBe(true)
  })

  it("recognizes findMany / findFirst as relational query terminals", () => {
    expect(isDrizzleQueryMethod("findMany")).toBe(true)
    expect(isDrizzleQueryMethod("findFirst")).toBe(true)
    expect(DRIZZLE_QUERY_METHODS.has("findMany")).toBe(true)
    expect(DRIZZLE_QUERY_METHODS.has("findFirst")).toBe(true)
  })

  it("does NOT include findUnique — that is Prisma vocabulary, not Drizzle", () => {
    // Prisma's Client exposes findUnique; Drizzle's relational query API does not.
    // Locking the disjoint vocabulary boundary between the two plugins.
    const untypedQuery = DRIZZLE_QUERY_METHODS as ReadonlySet<string>
    expect(untypedQuery.has("findUnique")).toBe(false)
    expect(isDrizzleQueryMethod("findUnique")).toBe(false)
  })

  it("keeps the read and write sets disjoint", () => {
    for (const m of DRIZZLE_READ_METHODS) {
      expect(DRIZZLE_WRITE_METHODS.has(m as never)).toBe(false)
    }
  })

  it("keeps transaction terminals disjoint from read/write", () => {
    for (const m of DRIZZLE_TRANSACTION_METHODS) {
      const untypedRead = DRIZZLE_READ_METHODS as ReadonlySet<string>
      const untypedWrite = DRIZZLE_WRITE_METHODS as ReadonlySet<string>
      expect(untypedRead.has(m)).toBe(false)
      expect(untypedWrite.has(m)).toBe(false)
    }
  })

  it("rejects unrelated method names for every set", () => {
    const untypedRead = DRIZZLE_READ_METHODS as ReadonlySet<string>
    const untypedWrite = DRIZZLE_WRITE_METHODS as ReadonlySet<string>
    const untypedTx = DRIZZLE_TRANSACTION_METHODS as ReadonlySet<string>
    const untypedQuery = DRIZZLE_QUERY_METHODS as ReadonlySet<string>
    for (const m of ["from", "where", "set", "values", "returning", "execute", "prepare"]) {
      expect(untypedRead.has(m)).toBe(false)
      expect(untypedWrite.has(m)).toBe(false)
      expect(untypedTx.has(m)).toBe(false)
      expect(untypedQuery.has(m)).toBe(false)
    }
  })

  it("collects every fluent-root verb into DRIZZLE_FLUENT_ROOT_METHODS", () => {
    // The chain-collapse reject pass in classify.ts reads this set. It must be the
    // union of the read verbs (select variants) and the write verbs (insert/update/
    // delete). Transaction and query terminals are excluded — they do not appear as
    // internal segments of another root's chain.
    for (const m of [
      "select",
      "selectDistinct",
      "selectDistinctOn",
      "insert",
      "update",
      "delete",
    ]) {
      expect(DRIZZLE_FLUENT_ROOT_METHODS.has(m)).toBe(true)
    }
    expect(DRIZZLE_FLUENT_ROOT_METHODS.has("transaction")).toBe(false)
    expect(DRIZZLE_FLUENT_ROOT_METHODS.has("batch")).toBe(false)
    expect(DRIZZLE_FLUENT_ROOT_METHODS.has("findMany")).toBe(false)
    expect(DRIZZLE_FLUENT_ROOT_METHODS.has("findFirst")).toBe(false)
  })
})
