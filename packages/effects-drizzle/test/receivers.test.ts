import { describe, expect, it } from "vitest"
import {
  DRIZZLE_CLIENT_WORDS,
  hasBuilderArgumentShape,
  hasTransactionArgumentShape,
  namesDrizzleClient,
  receiverConfidence,
} from "../src/index"
import { maxBuilderArguments } from "../src/methods"
import { makeCall } from "./fixtures/context"

describe("namesDrizzleClient", () => {
  it.each([
    "drizzle",
    "db",
    "database",
    "client",
    "conn",
    "connection",
    "orm",
    "tx",
    "trx",
    "transaction",
  ])("recognizes the bare client word %s", (segment) => {
    expect(namesDrizzleClient(segment)).toBe(true)
  })

  it("recognizes a client word inside a compound name", () => {
    expect(namesDrizzleClient("drizzleDb")).toBe(true)
    expect(namesDrizzleClient("_db")).toBe(true)
    expect(namesDrizzleClient("readReplicaDb")).toBe(true)
    expect(namesDrizzleClient("dbClient")).toBe(true)
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

describe("receiverConfidence", () => {
  it("is high when the receiver names a client binding", () => {
    expect(receiverConfidence("db", makeCall({ target: "db.select" }))).toBe("high")
    expect(receiverConfidence("tx", makeCall({ target: "tx.insert", argumentCount: 1 }))).toBe(
      "high",
    )
  })

  it("is medium when the receiver is a name this plugin cannot place", () => {
    expect(receiverConfidence("store", makeCall({ target: "store.select" }))).toBe("medium")
    expect(receiverConfidence(undefined, makeCall({ target: "db.select" }))).toBe("medium")
  })

  it("caps a dynamic receiver at medium however it is spelled", () => {
    // `getDb().select()` normalizes to `getDb.select`: a collapsed expression, not a
    // binding, so its spelling is not evidence of anything.
    expect(receiverConfidence("db", makeCall({ target: "db.select", dynamicReceiver: true }))).toBe(
      "medium",
    )
  })
})

describe("hasBuilderArgumentShape", () => {
  it("accepts the shapes a query-builder root actually takes", () => {
    expect(hasBuilderArgumentShape(makeCall({ target: "db.select" }), 1)).toBe(true)
    expect(
      hasBuilderArgumentShape(
        makeCall({ target: "db.insert", argumentCount: 1, literalArgs: [null] }),
        1,
      ),
    ).toBe(true)
  })

  it("rejects an Express route registration outright", () => {
    // `router.delete("/users/:id", handler)`: a string literal AND a second argument,
    // neither of which any Drizzle root takes.
    expect(
      hasBuilderArgumentShape(
        makeCall({
          target: "router.delete",
          argumentCount: 2,
          literalArgs: ["/users/:id", null],
        }),
        1,
      ),
    ).toBe(false)
  })

  it("rejects a literal first argument even on its own", () => {
    expect(
      hasBuilderArgumentShape(
        makeCall({ target: "router.delete", argumentCount: 1, literalArgs: ["/users/:id"] }),
        1,
      ),
    ).toBe(false)
  })

  it("honours the arity the terminal allows", () => {
    // `db.selectDistinctOn([users.id], { ... })` is a two-argument root on Postgres.
    const call = makeCall({
      target: "db.selectDistinctOn",
      argumentCount: 2,
      literalArgs: [null, null],
    })
    expect(hasBuilderArgumentShape(call, maxBuilderArguments("selectDistinctOn"))).toBe(true)
    expect(hasBuilderArgumentShape(call, maxBuilderArguments("select"))).toBe(false)
  })
})

describe("maxBuilderArguments", () => {
  it("allows two arguments for selectDistinctOn and one for every other root", () => {
    expect(maxBuilderArguments("selectDistinctOn")).toBe(2)
    for (const method of ["select", "selectDistinct", "insert", "update", "delete", "findMany"]) {
      expect(maxBuilderArguments(method)).toBe(1)
    }
  })
})

describe("hasTransactionArgumentShape", () => {
  it("allows the second options argument `transaction(cb, config)` takes", () => {
    expect(
      hasTransactionArgumentShape(
        makeCall({ target: "db.transaction", argumentCount: 2, literalArgs: [null, null] }),
      ),
    ).toBe(true)
  })

  it("rejects a literal first argument — a transaction takes a callback or statements", () => {
    expect(
      hasTransactionArgumentShape(
        makeCall({ target: "log.transaction", argumentCount: 1, literalArgs: ["begin"] }),
      ),
    ).toBe(false)
  })
})
