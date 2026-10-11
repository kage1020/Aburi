import { makeCall } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  classificationConfidence,
  namesPrismaClient,
  PRISMA_CLIENT_WORDS,
  PRISMA_DELEGATE_MAX_ARGUMENTS,
  PRISMA_TRANSACTION_MAX_ARGUMENTS,
} from "../src/index"

describe("namesPrismaClient", () => {
  it.each([
    "prisma",
    "db",
    "database",
    "orm",
    "tx",
    "trx",
    "prismaClient",
    "_prisma",
    "readReplicaDb",
    "dbClient",
    "prisma2",
  ])("recognizes %s, which spells a client word", (segment) => {
    expect(namesPrismaClient(segment)).toBe(true)
  })

  it.each([
    ["apiClient", "an SDK client, whose calls take a delegate's shape too"],
    ["httpClient", "an SDK client, whose calls take a delegate's shape too"],
    ["s3Client", "an SDK client, whose calls take a delegate's shape too"],
    ["paymentTransaction", "a domain noun ending in `transaction`"],
    ["transactionLog", "a domain noun starting with `transaction`"],
    ["datasource", "`datasource` in lower case"],
    ["dataSource", "`datasource` in camel case"],
    ["cache", "a receiver sharing Prisma's verbs"],
    ["items", "a receiver sharing Prisma's verbs"],
    ["router", "a receiver sharing Prisma's verbs"],
    ["session", "a receiver sharing Prisma's verbs"],
    ["feedback", "a word that merely contains `db`"],
    ["context", "a word that merely contains `tx`"],
  ])("rejects %s — %s", (segment) => {
    expect(namesPrismaClient(segment)).toBe(false)
  })

  it("exposes the vocabulary as a set so a house convention can be checked against it", () => {
    expect(PRISMA_CLIENT_WORDS.has("prisma")).toBe(true)
    expect((PRISMA_CLIENT_WORDS as ReadonlySet<string>).has("cache")).toBe(false)
  })
})

describe("classificationConfidence", () => {
  it.each([
    [
      "high for a client binding",
      "prisma",
      makeCall({ target: "prisma.user.create" }),
      PRISMA_DELEGATE_MAX_ARGUMENTS,
      "high",
    ],
    [
      "medium for a receiver it cannot place",
      "cache",
      makeCall({ target: "this.cache.items.delete" }),
      PRISMA_DELEGATE_MAX_ARGUMENTS,
      "medium",
    ],
    [
      "medium with no receiver at all",
      undefined,
      makeCall({ target: "user.create" }),
      PRISMA_DELEGATE_MAX_ARGUMENTS,
      "medium",
    ],
    [
      "medium for a dynamic receiver however it is spelled",
      "prisma",
      makeCall({ target: "prisma.user.create", dynamicReceiver: true }),
      PRISMA_DELEGATE_MAX_ARGUMENTS,
      "medium",
    ],
    [
      "medium for a delegate call with two arguments",
      "prisma",
      makeCall({ target: "prisma.user.update", argumentCount: 2 }),
      PRISMA_DELEGATE_MAX_ARGUMENTS,
      "medium",
    ],
    [
      "high for $transaction(fn, options), which takes two",
      "prisma",
      makeCall({ target: "prisma.$transaction", argumentCount: 2 }),
      PRISMA_TRANSACTION_MAX_ARGUMENTS,
      "high",
    ],
  ] as const)("is %s", (_label, client, call, maxArguments, expected) => {
    expect(classificationConfidence(client, call, maxArguments)).toBe(expected)
  })
})
