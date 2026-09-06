import { describe, expect, it } from "vitest"
import { classificationConfidence, DRIZZLE_CLIENT_WORDS, namesDrizzleClient } from "../src/index"
import { maxArgumentsFor } from "../src/methods"
import { makeCall } from "./fixtures/context"

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
    // `httpClient.delete(url)` is 2 segments with a write terminal and one non-literal
    // argument: everything `db.delete(users)` is, on a receiver that is not a database.
    for (const segment of ["httpClient", "apiClient", "redisClient", "sdkClient", "s3Client"]) {
      expect(namesDrizzleClient(segment)).toBe(false)
    }
  })

  it("rejects a domain noun that ends in `transaction`", () => {
    expect(namesDrizzleClient("paymentTransaction")).toBe(false)
    expect(namesDrizzleClient("transactionLog")).toBe(false)
  })

  it("rejects the everyday receivers that share Drizzle's terminal vocabulary", () => {
    // `router.delete` (Express) and `store.select` (RxJS) are the two collisions the
    // package's own docstring names; the file-level import gate does not separate them
    // because Express + Drizzle is a common pairing inside one file.
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
    // `getDb().select()` normalizes to `getDb.select`: a collapsed expression, not a
    // binding, so its spelling is not evidence of anything.
    expect(
      classificationConfidence("db", makeCall({ target: "db.select", dynamicReceiver: true }), 1),
    ).toBe("medium")
  })

  it("caps an over-long argument list at medium rather than dropping the call", () => {
    // `argumentCount` is a syntactic count and this is the first code to read it as a
    // signature, so an overflow costs the tier instead of erasing the effect.
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
