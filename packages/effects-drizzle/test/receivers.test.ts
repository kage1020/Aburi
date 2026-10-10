import { makeCall } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classificationConfidence, DRIZZLE_CLIENT_WORDS, namesDrizzleClient } from "../src/index"

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
    "drizzleDb",
    "_db",
    "readReplicaDb",
    "dbClient",
  ])("recognizes %s, which spells a client word", (segment) => {
    expect(namesDrizzleClient(segment)).toBe(true)
  })

  it.each([
    ["httpClient", "an SDK client"],
    ["apiClient", "an SDK client"],
    ["redisClient", "an SDK client"],
    ["s3Client", "an SDK client"],
    ["paymentTransaction", "a domain noun ending in `transaction`"],
    ["transactionLog", "a domain noun starting with `transaction`"],
    ["router", "a receiver sharing Drizzle's verbs"],
    ["store", "a receiver sharing Drizzle's verbs"],
    ["form", "a receiver sharing Drizzle's verbs"],
    ["feedback", "a word that merely contains `db`"],
    ["context", "a word that merely contains `tx`"],
  ])("rejects %s — %s", (segment) => {
    expect(namesDrizzleClient(segment)).toBe(false)
  })

  it("exposes the vocabulary as a set so a house convention can be checked against it", () => {
    expect(DRIZZLE_CLIENT_WORDS.has("db")).toBe(true)
    expect((DRIZZLE_CLIENT_WORDS as ReadonlySet<string>).has("router")).toBe(false)
  })
})

describe("classificationConfidence", () => {
  it.each([
    [
      "high for a client binding whose arity fits",
      "db",
      makeCall({ target: "db.select" }),
      1,
      "high",
    ],
    [
      "medium for a receiver it cannot place",
      "store",
      makeCall({ target: "store.select" }),
      1,
      "medium",
    ],
    ["medium with no receiver at all", undefined, makeCall({ target: "select" }), 1, "medium"],
    [
      "medium for a dynamic receiver however it is spelled",
      "db",
      makeCall({ target: "db.select", dynamicReceiver: true }),
      1,
      "medium",
    ],
    [
      "medium for more arguments than the terminal takes",
      "db",
      makeCall({ target: "db.delete", argumentCount: 2 }),
      1,
      "medium",
    ],
    [
      "high for as many arguments as the terminal takes",
      "db",
      makeCall({ target: "db.selectDistinctOn", argumentCount: 2 }),
      2,
      "high",
    ],
  ] as const)("is %s", (_label, client, call, maxArguments, expected) => {
    expect(classificationConfidence(client, call, maxArguments)).toBe(expected)
  })
})
