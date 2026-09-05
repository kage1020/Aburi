import { describe, expect, it } from "vitest"
import {
  hasDelegateArgumentShape,
  namesPrismaClient,
  PRISMA_CLIENT_WORDS,
  receiverConfidence,
} from "../src/index"
import { makeCall } from "./fixtures/context"

describe("namesPrismaClient", () => {
  it.each([
    "prisma",
    "db",
    "database",
    "client",
    "datasource",
    "orm",
    "tx",
    "trx",
    "transaction",
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

describe("receiverConfidence", () => {
  it("is high when the receiver names a client binding", () => {
    expect(receiverConfidence("prisma", makeCall({ target: "prisma.user.create" }))).toBe("high")
    expect(receiverConfidence("db", makeCall({ target: "this.db.user.create" }))).toBe("high")
  })

  it("is medium when the receiver is a name this plugin cannot place", () => {
    // Not null: a client under a house naming convention and an unrelated object of the
    // same shape are indistinguishable from the callee string alone, so the tier carries
    // the uncertainty instead of the classification being invented or dropped.
    expect(receiverConfidence("cache", makeCall({ target: "this.cache.items.delete" }))).toBe(
      "medium",
    )
    expect(receiverConfidence(undefined, makeCall({ target: "prisma.user.create" }))).toBe("medium")
  })

  it("caps a dynamic receiver at medium however it is spelled", () => {
    // `getPrisma().user.create()` normalizes to `getPrisma.user.create`: the segment is a
    // collapsed expression, not a binding, so its spelling is not evidence of anything.
    expect(
      receiverConfidence(
        "prisma",
        makeCall({ target: "prisma.user.create", dynamicReceiver: true }),
      ),
    ).toBe("medium")
  })
})

describe("hasDelegateArgumentShape", () => {
  it("accepts the shapes a Prisma delegate method actually takes", () => {
    expect(hasDelegateArgumentShape(makeCall({ target: "prisma.user.findMany" }))).toBe(true)
    expect(
      hasDelegateArgumentShape(
        makeCall({ target: "prisma.user.create", argumentCount: 1, literalArgs: [null] }),
      ),
    ).toBe(true)
  })

  it("rejects a literal first argument — no delegate method takes one", () => {
    expect(
      hasDelegateArgumentShape(
        makeCall({ target: "cache.items.delete", argumentCount: 1, literalArgs: ["session"] }),
      ),
    ).toBe(false)
  })

  it("rejects a second argument — every delegate method takes one options object at most", () => {
    expect(
      hasDelegateArgumentShape(
        makeCall({ target: "emitter.user.update", argumentCount: 2, literalArgs: [null, null] }),
      ),
    ).toBe(false)
  })
})
