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
  ])("recognizes the bare client word %s", (segment) => {
    expect(namesPrismaClient(segment)).toBe(true)
  })

  it("recognizes a client word inside a compound name", () => {
    expect(namesPrismaClient("prismaClient")).toBe(true)
    expect(namesPrismaClient("_prisma")).toBe(true)
    expect(namesPrismaClient("readReplicaDb")).toBe(true)
    expect(namesPrismaClient("dbClient")).toBe(true)
    expect(namesPrismaClient("prisma2")).toBe(true)
  })

  it("rejects an SDK client — `<client>.<resource>.<verb>` is a delegate's shape too", () => {
    for (const segment of ["apiClient", "httpClient", "redisClient", "sdkClient", "s3Client"]) {
      expect(namesPrismaClient(segment)).toBe(false)
    }
  })

  it("rejects a domain noun that ends in `transaction`", () => {
    expect(namesPrismaClient("paymentTransaction")).toBe(false)
    expect(namesPrismaClient("transactionLog")).toBe(false)
  })

  it("rejects the everyday receivers that share Prisma's verb vocabulary", () => {
    for (const segment of ["cache", "items", "router", "store", "queue", "session", "res"]) {
      expect(namesPrismaClient(segment)).toBe(false)
    }
  })

  it("does not fall for a substring — `feedback` is not `db`", () => {
    expect(namesPrismaClient("feedback")).toBe(false)
    expect(namesPrismaClient("context")).toBe(false)
  })

  it("exposes the vocabulary as a set so a house convention can be checked against it", () => {
    expect(PRISMA_CLIENT_WORDS.has("prisma")).toBe(true)
    expect((PRISMA_CLIENT_WORDS as ReadonlySet<string>).has("cache")).toBe(false)
  })
})

describe("classificationConfidence", () => {
  const delegateMax = PRISMA_DELEGATE_MAX_ARGUMENTS

  it("is high when the receiver names a client binding", () => {
    expect(
      classificationConfidence("prisma", makeCall({ target: "prisma.user.create" }), delegateMax),
    ).toBe("high")
    expect(
      classificationConfidence("db", makeCall({ target: "this.db.user.create" }), delegateMax),
    ).toBe("high")
  })

  it("is medium when the receiver is a name this plugin cannot place", () => {
    expect(
      classificationConfidence(
        "cache",
        makeCall({ target: "this.cache.items.delete" }),
        delegateMax,
      ),
    ).toBe("medium")
    expect(
      classificationConfidence(undefined, makeCall({ target: "prisma.user.create" }), delegateMax),
    ).toBe("medium")
  })

  it("caps a dynamic receiver at medium however it is spelled", () => {
    expect(
      classificationConfidence(
        "prisma",
        makeCall({ target: "prisma.user.create", dynamicReceiver: true }),
        delegateMax,
      ),
    ).toBe("medium")
  })

  it("caps an over-long argument list at medium rather than dropping the call", () => {
    expect(
      classificationConfidence(
        "prisma",
        makeCall({ target: "prisma.user.update", argumentCount: 2, literalArgs: [null, null] }),
        delegateMax,
      ),
    ).toBe("medium")
  })

  it("gives $transaction the wider arity its own signature takes", () => {
    // `$transaction(fn, { timeout })` is two arguments and still Prisma's own API.
    expect(
      classificationConfidence(
        "prisma",
        makeCall({ target: "prisma.$transaction", argumentCount: 2, literalArgs: [null, null] }),
        PRISMA_TRANSACTION_MAX_ARGUMENTS,
      ),
    ).toBe("high")
  })
})
