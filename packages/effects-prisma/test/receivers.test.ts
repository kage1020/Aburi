import { describe, expect, it } from "vitest"
import {
  classificationConfidence,
  namesPrismaClient,
  PRISMA_CLIENT_WORDS,
  PRISMA_DELEGATE_MAX_ARGUMENTS,
  PRISMA_TRANSACTION_MAX_ARGUMENTS,
} from "../src/index"
import { makeCall } from "./fixtures/context"

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
    // `apiClient.users.update(payload)` reaches the same branch as `prisma.user.update`.
    // A `client` word in the vocabulary would have handed it `high`, which is the bug
    // class this module exists to close.
    for (const segment of ["apiClient", "httpClient", "redisClient", "sdkClient", "s3Client"]) {
      expect(namesPrismaClient(segment)).toBe(false)
    }
  })

  it("rejects a domain noun that ends in `transaction`", () => {
    expect(namesPrismaClient("paymentTransaction")).toBe(false)
    expect(namesPrismaClient("transactionLog")).toBe(false)
  })

  it("rejects the everyday receivers that share Prisma's verb vocabulary", () => {
    // `delete` / `create` / `update` are Map, Set, DOM and HTTP-router vocabulary too, so
    // these are exactly the names that must not read as a database client.
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
    // Not null: a client under a house naming convention and an unrelated object of the
    // same shape are indistinguishable from the callee string alone, so the tier carries
    // the uncertainty instead of the classification being invented or dropped.
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
    // `getPrisma().user.create()` normalizes to `getPrisma.user.create`: the segment is a
    // collapsed expression, not a binding, so its spelling is not evidence of anything.
    expect(
      classificationConfidence(
        "prisma",
        makeCall({ target: "prisma.user.create", dynamicReceiver: true }),
        delegateMax,
      ),
    ).toBe("medium")
  })

  it("caps an over-long argument list at medium rather than dropping the call", () => {
    // `argumentCount` is a syntactic count and this is the first code to read it as a
    // signature, so an overflow costs the tier instead of erasing the effect.
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
