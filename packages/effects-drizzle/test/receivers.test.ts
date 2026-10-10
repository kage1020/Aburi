import { makeCall } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classificationConfidence, DRIZZLE_CLIENT_WORDS, namesDrizzleClient } from "../src/index"
import { maxArgumentsFor, minArgumentsFor } from "../src/methods"

describe("namesDrizzleClient", () => {
  it.each([
    "drizzle",
    "db",
    "database",
    "conn",
    "connection",
    "orm",
    "tx",
    "trx",
  ])("recognizes the bare client word %s", (segment) => {
    expect(namesDrizzleClient(segment)).toBe(true)
  })

  it("recognizes a client word inside a compound name", () => {
    expect(namesDrizzleClient("drizzleDb")).toBe(true)
    expect(namesDrizzleClient("_db")).toBe(true)
    expect(namesDrizzleClient("readReplicaDb")).toBe(true)
    // Matches on `db`, not on `client` — which is not in the vocabulary at all.
    expect(namesDrizzleClient("dbClient")).toBe(true)
  })

  it("rejects an SDK client — `client` alone would hand every one of these `high`", () => {
    for (const segment of ["httpClient", "apiClient", "redisClient", "sdkClient", "s3Client"]) {
      expect(namesDrizzleClient(segment)).toBe(false)
    }
  })

  it("rejects a domain noun that ends in `transaction`", () => {
    expect(namesDrizzleClient("paymentTransaction")).toBe(false)
    expect(namesDrizzleClient("transactionLog")).toBe(false)
  })

  it("rejects the everyday receivers that share Drizzle's terminal vocabulary", () => {
    for (const segment of ["router", "app", "store", "queue", "cache", "form", "list"]) {
      expect(namesDrizzleClient(segment)).toBe(false)
    }
  })

  it("does not fall for a substring — `feedback` is not `db`", () => {
    expect(namesDrizzleClient("feedback")).toBe(false)
    expect(namesDrizzleClient("context")).toBe(false)
  })

  it("exposes the vocabulary as a set so a house convention can be checked against it", () => {
    expect(DRIZZLE_CLIENT_WORDS.has("db")).toBe(true)
    expect((DRIZZLE_CLIENT_WORDS as ReadonlySet<string>).has("router")).toBe(false)
  })
})

describe("classificationConfidence", () => {
  it("is high when the receiver names a client binding and the arity fits", () => {
    expect(classificationConfidence("db", makeCall({ target: "db.select" }), 1)).toBe("high")
    expect(
      classificationConfidence("tx", makeCall({ target: "tx.insert", argumentCount: 1 }), 1),
    ).toBe("high")
  })

  it("is medium when the receiver is a name this plugin cannot place", () => {
    expect(classificationConfidence("store", makeCall({ target: "store.select" }), 1)).toBe(
      "medium",
    )
    expect(classificationConfidence(undefined, makeCall({ target: "db.select" }), 1)).toBe("medium")
  })

  it("caps a dynamic receiver at medium however it is spelled", () => {
    expect(
      classificationConfidence("db", makeCall({ target: "db.select", dynamicReceiver: true }), 1),
    ).toBe("medium")
  })

  it("caps an over-long argument list at medium rather than dropping the call", () => {
    expect(
      classificationConfidence(
        "db",
        makeCall({ target: "db.delete", argumentCount: 2, literalArgs: [null, null] }),
        1,
      ),
    ).toBe("medium")
  })

  it("honours the arity the terminal allows", () => {
    // `db.selectDistinctOn([users.id], { ... })` is a two-argument root on Postgres.
    const call = makeCall({
      target: "db.selectDistinctOn",
      argumentCount: 2,
      literalArgs: [null, null],
    })
    expect(classificationConfidence("db", call, maxArgumentsFor("selectDistinctOn"))).toBe("high")
    expect(classificationConfidence("db", call, maxArgumentsFor("select"))).toBe("medium")
  })
})

describe("maxArgumentsFor", () => {
  it("allows two arguments for selectDistinctOn and transaction, one for the rest", () => {
    expect(maxArgumentsFor("selectDistinctOn")).toBe(2)
    expect(maxArgumentsFor("transaction")).toBe(2)
    for (const method of ["select", "selectDistinct", "insert", "update", "delete", "findMany"]) {
      expect(maxArgumentsFor(method)).toBe(1)
    }
    expect(maxArgumentsFor("batch")).toBe(1)
  })
})

describe("minArgumentsFor", () => {
  it("requires one argument for the write and transaction terminals", () => {
    for (const method of ["insert", "update", "delete", "transaction", "batch"]) {
      expect(minArgumentsFor(method)).toBe(1)
    }
  })

  it("lets the read and relational query terminals be called bare", () => {
    for (const method of [
      "select",
      "selectDistinct",
      "selectDistinctOn",
      "findMany",
      "findFirst",
    ]) {
      expect(minArgumentsFor(method)).toBe(0)
    }
  })

  it("returns 0 for a name outside the vocabulary", () => {
    // The classifier answers `null` for these whatever the floor says, so only a direct case
    // sees this default. `constructor` is there for a table rewritten as an object literal,
    // where the lookup would reach `Object.prototype`.
    for (const method of ["from", "commit", "findUnique", "constructor"]) {
      expect(minArgumentsFor(method)).toBe(0)
    }
  })
})
