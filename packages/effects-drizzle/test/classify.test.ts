import { makeCall, makeCtx } from "@aburi/test-support"
import type { CallCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyDrizzleCall } from "../src/index"
import { makeDrizzleImport } from "./fixtures/context"

const ctx = makeCtx({ imports: [makeDrizzleImport()] })

const classify = (target: string, overrides: Partial<CallCandidate> = {}) =>
  classifyDrizzleCall(makeCall({ target, ...overrides }), ctx)

describe("classifyDrizzleCall — terminals", () => {
  it.each([
    "select",
    "selectDistinct",
    "selectDistinctOn",
  ])("classifies db.%s as db.read", (method) => {
    expect(classify(`db.${method}`)).toEqual({
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-plugin:drizzle:read",
    })
  })

  it.each(["insert", "update", "delete"])("classifies db.%s(table) as db.write", (method) => {
    expect(classify(`db.${method}`, { argumentCount: 1 })).toEqual({
      effectId: "db.write",
      confidence: "high",
      derivedBy: "effects-plugin:drizzle:write",
    })
  })

  it.each(["transaction", "batch"])("classifies db.%s(arg) as db.transaction", (method) => {
    expect(classify(`db.${method}`, { argumentCount: 1 })).toEqual({
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: "effects-plugin:drizzle:tx",
    })
  })

  it.each([
    "db.query.users.findMany",
    "db.query.users.findFirst",
    "this.db.query.users.findMany",
  ])("classifies the relational query %s as db.read", (target) => {
    expect(classify(target, { argumentCount: 1 })).toEqual({
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-plugin:drizzle:read",
    })
  })
})

describe("classifyDrizzleCall — one classification per fluent chain", () => {
  it.each([
    "db.select.from",
    "db.select.from.where",
    "db.select.from.where.orderBy",
    "db.select.from.leftJoin.where.orderBy.limit",
    "db.selectDistinct.from.groupBy",
    "db.selectDistinctOn.from.where",
    "db.insert.values",
    "db.insert.values.returning",
    "db.insert.values.onConflictDoUpdate",
    "db.update.set",
    "db.update.set.where",
    "db.update.set.where.returning",
    "db.delete.where",
    "db.delete.where.returning",
  ])("returns null for the chain link %s, whose root already classifies", (target) => {
    expect(classify(target)).toBeNull()
  })
})

describe("classifyDrizzleCall — receiver and arguments decide the tier", () => {
  it.each([
    ["this.db.select", 0],
    ["container.services.db.select", 0],
    ["this.db.transaction", 1],
    ["tx.insert", 1],
    ["db.query.users.findFirst", 0],
    ["db.selectDistinctOn", 2],
    ["db.transaction", 2],
  ])("keeps %s with %i argument(s) at high", (target, argumentCount) => {
    const literalArgs = Array.from({ length: argumentCount }, () => null)
    expect(classify(target, { argumentCount, literalArgs })?.confidence).toBe("high")
  })

  it.each([
    ["store.select", 0, "db.read"],
    ["form.delete", 1, "db.write"],
    ["sequelize.transaction", 1, "db.transaction"],
    ["cache.query.users.findMany", 0, "db.read"],
  ])("still records %s, on a receiver it cannot place, at medium", (target, argumentCount, effectId) => {
    expect(classify(target, { argumentCount })).toMatchObject({ effectId, confidence: "medium" })
  })

  it("caps a dynamic receiver at medium", () => {
    expect(classify("getDb.select", { dynamicReceiver: true })).toMatchObject({
      effectId: "db.read",
      confidence: "medium",
    })
  })

  it("downgrades an over-long argument list rather than dropping the call", () => {
    expect(classify("db.delete", { argumentCount: 2, literalArgs: [null, null] })).toMatchObject({
      effectId: "db.write",
      confidence: "medium",
    })
  })

  it.each([
    "db.insert",
    "db.update",
    "db.delete",
    "this.update",
    "form.delete",
    "user.delete",
    "db.transaction",
    "db.batch",
    "firestore.batch",
    "sequelize.transaction",
    "this.transaction",
  ])("returns null for a zero-argument %s — every write and transaction terminal takes one", (target) => {
    expect(classify(target, { argumentCount: 0 })).toBeNull()
  })

  it.each([
    ["router.delete", ["/users/:id", null]],
    ["router.update", ["/path"]],
    ["router.insert", ["/path"]],
    ["emitter.select", ["/path"]],
    ["log.transaction", ["begin"]],
    ["cache.query.users.findMany", ["key"]],
  ])("returns null for %s handed a literal first argument — no Drizzle terminal takes one", (target, literalArgs) => {
    expect(classify(target, { argumentCount: literalArgs.length, literalArgs })).toBeNull()
  })
})

describe("classifyDrizzleCall — calls that are not Drizzle's", () => {
  it.each([
    ["no import at all", []],
    [
      "another ORM",
      [{ source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }],
    ],
  ])("returns null in a file that imports %s instead of drizzle-orm", (_label, imports) => {
    expect(classifyDrizzleCall(makeCall({ target: "db.select" }), makeCtx({ imports }))).toBeNull()
  })

  it.each([
    ["select", "a bare identifier"],
    ["insert", "a bare identifier"],
    ["transaction", "a bare identifier"],
    ["db.execute", "raw SQL, which may read or write"],
    ["this.db.execute", "raw SQL, which may read or write"],
    ["db.someHelper", "a method outside the vocabulary"],
    ["db.prepare", "a method outside the vocabulary"],
    ["db.query.users.findUnique", "Prisma's verb on the query API"],
    ["db.users.findMany", "a query terminal without the `query` segment"],
    ["db.query.findMany", "a query terminal without a table segment"],
  ])("returns null for %s — %s", (target) => {
    expect(classify(target, { argumentCount: 1 })).toBeNull()
  })
})

describe("classifyDrizzleCall — upstream contract violations", () => {
  const path = "src/services/x.ts"

  it.each([
    ["", "CallCandidate.target is empty"],
    ["db..insert", 'CallCandidate.target "db..insert" has empty segment(s)'],
    [".select", 'CallCandidate.target ".select" has empty segment(s)'],
    ["db.select.", 'CallCandidate.target "db.select." has empty segment(s)'],
  ])("throws on the malformed target %j, naming itself and the file, before the import gate", (target, message) => {
    for (const imports of [[makeDrizzleImport()], []]) {
      expect(() => classifyDrizzleCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
        `effects-drizzle (${path}): ${message}`,
      )
    }
  })

  it("throws on an import edge with an empty source rather than skipping it", () => {
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["drizzle"], line: 2, dynamic: false }],
      path,
    })
    expect(() => classifyDrizzleCall(makeCall({ target: "db.select" }), brokenEdge)).toThrow(
      `effects-drizzle (${path}, line 2): ImportEdge.source is empty`,
    )
  })

  it("leaves the CallCandidate and the ClassifyContext as it found them", () => {
    const call = makeCall({ target: "db.insert", argumentCount: 1, literalArgs: [null] })
    const before = structuredClone({ call, file: ctx.file, owner: ctx.owner })
    classifyDrizzleCall(call, ctx)
    expect({ call, file: ctx.file, owner: ctx.owner }).toEqual(before)
  })
})
