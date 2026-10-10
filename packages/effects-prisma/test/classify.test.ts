import { makeCall, makeCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyPrismaCall } from "../src/index"
import { makePrismaImport } from "./fixtures/context"

const ctx = makeCtx({ imports: [makePrismaImport()] })

describe("classifyPrismaCall — delegate and transaction calls", () => {
  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "count",
    "aggregate",
    "groupBy",
  ])("classifies prisma.user.%s as db.read", (method) => {
    expect(classifyPrismaCall(makeCall({ target: `prisma.user.${method}` }), ctx)).toEqual({
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:read",
    })
  })

  it.each([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
  ])("classifies prisma.invoice.%s as db.write", (method) => {
    expect(classifyPrismaCall(makeCall({ target: `prisma.invoice.${method}` }), ctx)).toEqual({
      effectId: "db.write",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:write",
    })
  })

  it.each([
    "prisma.$transaction",
    "this.prisma.$transaction",
    "services.prisma.$transaction",
  ])("classifies %s as db.transaction", (target) => {
    expect(classifyPrismaCall(makeCall({ target }), ctx)).toEqual({
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:tx",
    })
  })
})

describe("classifyPrismaCall — receiver identification", () => {
  it.each([
    "prisma.user.findMany",
    "this.prisma.user.create",
    "db.user.update",
    "this.prismaClient.user.upsert",
    "container.services.prisma.user.findMany",
    "tx.user.create",
  ])("keeps %s, a receiver Prisma is written with, at high", (target) => {
    expect(classifyPrismaCall(makeCall({ target }), ctx)?.confidence).toBe("high")
  })

  it("still classifies an unrecognized receiver, at medium — recall is not the price", () => {
    expect(classifyPrismaCall(makeCall({ target: "this.repo.user.create" }), ctx)).toEqual({
      effectId: "db.write",
      confidence: "medium",
      derivedBy: "effects-plugin:prisma:write",
    })
  })

  it("caps a dynamic receiver at medium", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "getPrisma.user.create", dynamicReceiver: true }),
      ctx,
    )
    expect(result).toMatchObject({ effectId: "db.write", confidence: "medium" })
  })

  it("applies the same tiering to $transaction", () => {
    expect(classifyPrismaCall(makeCall({ target: "prisma.$transaction" }), ctx)?.confidence).toBe(
      "high",
    )
    expect(classifyPrismaCall(makeCall({ target: "queue.$transaction" }), ctx)?.confidence).toBe(
      "medium",
    )
  })

  it("returns null for a delegate verb called with a literal — no delegate takes one", () => {
    expect(
      classifyPrismaCall(
        makeCall({ target: "this.cache.items.delete", argumentCount: 1, literalArgs: ["session"] }),
        ctx,
      ),
    ).toBeNull()
  })

  it("downgrades a delegate verb called with two arguments rather than dropping it", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.user.update", argumentCount: 2, literalArgs: [null, null] }),
      ctx,
    )
    expect(result).toMatchObject({ effectId: "db.write", confidence: "medium" })
  })

  it("keeps $transaction(fn, options) at high — its signature takes two arguments", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.$transaction", argumentCount: 2, literalArgs: [null, null] }),
      ctx,
    )
    expect(result).toMatchObject({ effectId: "db.transaction", confidence: "high" })
  })
})

describe("classifyPrismaCall — a model segment that names nothing", () => {
  it.each([
    "prisma.<computed>.create",
    "this.prisma.<computed>.update",
  ])("keeps the write on %s, whose receiver names a client, at the tier the flag sets", (target) => {
    expect(classifyPrismaCall(makeCall({ target, dynamicReceiver: true }), ctx)).toMatchObject({
      effectId: "db.write",
      confidence: "medium",
    })
  })

  it.each([
    "queues.<computed>.upsert",
    "sets.<computed>.delete",
    "router.<computed>.create",
  ])("does not let the sentinel buy the delegate shape for %s", (target) => {
    expect(classifyPrismaCall(makeCall({ target, dynamicReceiver: true }), ctx)).toBeNull()
  })

  it("returns null when the verb itself is the segment that names nothing", () => {
    expect(
      classifyPrismaCall(
        makeCall({ target: "prisma.user.<computed>", dynamicReceiver: true }),
        ctx,
      ),
    ).toBeNull()
  })
})

describe("classifyPrismaCall — calls that are not Prisma's", () => {
  it.each([
    ["no import at all", []],
    ["another ORM", [{ source: "drizzle-orm", symbols: ["*"], line: 1, dynamic: false }]],
  ])("returns null in a file that imports %s instead of @prisma/client", (_label, imports) => {
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.user.findMany" }), makeCtx({ imports })),
    ).toBeNull()
  })

  it.each([
    ["findMany", "a bare identifier"],
    ["router.create", "a two-segment call reusing a delegate verb"],
    ["list.findMany", "a two-segment call reusing a delegate verb"],
    ["queue.upsert", "a two-segment call reusing a delegate verb"],
    ["prisma.user.executeRaw", "a method outside the delegate surface"],
    ["prisma.user.someHelper", "a method outside the delegate surface"],
    ["prisma.$queryRaw", "a raw SQL escape"],
    ["prisma.$executeRaw", "a raw SQL escape"],
    ["prisma.$queryRawUnsafe", "a raw SQL escape"],
    ["prisma.$transactional", "a near-miss of $transaction"],
    ["$transaction", "$transaction with no client"],
  ])("returns null for %s — %s", (target) => {
    expect(classifyPrismaCall(makeCall({ target }), ctx)).toBeNull()
  })
})

describe("classifyPrismaCall — upstream contract violations", () => {
  const path = "src/services/x.ts"

  it.each([
    ["", "CallCandidate.target is empty"],
    ["prisma..create", 'CallCandidate.target "prisma..create" has empty segment(s)'],
    [".create", 'CallCandidate.target ".create" has empty segment(s)'],
    ["prisma.user.", 'CallCandidate.target "prisma.user." has empty segment(s)'],
  ])("throws on the malformed target %j, naming itself and the file, before the import gate", (target, message) => {
    for (const imports of [[makePrismaImport()], []]) {
      expect(() => classifyPrismaCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
        `effects-prisma (${path}): ${message}`,
      )
    }
  })

  it("throws on an import edge with an empty source rather than skipping it", () => {
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["PrismaClient"], line: 4, dynamic: false }],
      path,
    })
    expect(() =>
      classifyPrismaCall(makeCall({ target: "prisma.user.create" }), brokenEdge),
    ).toThrow(`effects-prisma (${path}, line 4): ImportEdge.source is empty`)
  })

  it("leaves the CallCandidate and the ClassifyContext as it found them", () => {
    const call = makeCall({ target: "prisma.user.findMany", literalArgs: ["value"] })
    const before = structuredClone({ call, file: ctx.file, owner: ctx.owner })
    classifyPrismaCall(call, ctx)
    expect({ call, file: ctx.file, owner: ctx.owner }).toEqual(before)
  })
})
