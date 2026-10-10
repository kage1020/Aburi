import { makeCall, makeCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyPrismaCall } from "../src/index"
import { makePrismaImport } from "./fixtures/context"

describe("classifyPrismaCall — read methods", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

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
    const result = classifyPrismaCall(makeCall({ target: `prisma.user.${method}` }), ctx)
    expect(result?.effectId).toBe("db.read")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:prisma:read")
  })

  it("accepts arbitrary leading segments (this.prisma.model.verb)", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "this.prisma.user.findMany" }), ctx)?.effectId,
    ).toBe("db.read")
  })

  it("accepts deeply chained accessors (container.services.prisma.user.findMany)", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "container.services.prisma.user.findMany" }), ctx)
        ?.effectId,
    ).toBe("db.read")
  })
})

describe("classifyPrismaCall — write methods", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

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
    const result = classifyPrismaCall(makeCall({ target: `prisma.invoice.${method}` }), ctx)
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:prisma:write")
  })
})

describe("classifyPrismaCall — transaction", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

  it("classifies prisma.$transaction as db.transaction", () => {
    const result = classifyPrismaCall(makeCall({ target: "prisma.$transaction" }), ctx)
    expect(result?.effectId).toBe("db.transaction")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:prisma:tx")
  })

  it("classifies this.prisma.$transaction as db.transaction", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "this.prisma.$transaction" }), ctx)?.effectId,
    ).toBe("db.transaction")
  })
})

describe("classifyPrismaCall — receiver identification", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

  it("does not claim `high` for a Map call that shares the delegate vocabulary", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "this.cache.items.delete", argumentCount: 1, literalArgs: [null] }),
      ctx,
    )
    expect(result?.confidence).toBe("medium")
  })

  it("keeps `high` for the receivers Prisma is actually written with", () => {
    for (const target of [
      "prisma.user.findMany",
      "this.prisma.user.create",
      "db.user.update",
      "this.prismaClient.user.upsert",
      "container.services.prisma.user.findMany",
      "tx.user.create",
    ]) {
      expect(classifyPrismaCall(makeCall({ target }), ctx)?.confidence).toBe("high")
    }
  })

  it("still classifies an unrecognized receiver, at medium — recall is not the price", () => {
    const result = classifyPrismaCall(makeCall({ target: "this.repo.user.create" }), ctx)
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
    expect(result?.derivedBy).toBe("effects-plugin:prisma:write")
  })

  it("caps a dynamic receiver at medium", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "getPrisma.user.create", dynamicReceiver: true }),
      ctx,
    )
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
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
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
  })

  it("keeps a write whose argument list carries a comment", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.user.delete", argumentCount: 1, literalArgs: [null] }),
      ctx,
    )
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("high")
  })

  it("leaves $transaction's own argument shapes alone", () => {
    expect(
      classifyPrismaCall(
        makeCall({ target: "prisma.$transaction", argumentCount: 2, literalArgs: [null, null] }),
        ctx,
      )?.effectId,
    ).toBe("db.transaction")
  })
})

describe("classifyPrismaCall — negative paths", () => {
  const ctxWithPrisma = makeCtx({ imports: [makePrismaImport()] })

  it("returns null when the file does not import @prisma/client", () => {
    const ctxNoImport = makeCtx({ imports: [] })
    expect(classifyPrismaCall(makeCall({ target: "prisma.user.findMany" }), ctxNoImport)).toBeNull()
  })

  it("returns null when the file imports a different ORM", () => {
    const ctxOther = makeCtx({
      imports: [{ source: "drizzle-orm", symbols: ["*"], line: 1, dynamic: false }],
    })
    expect(classifyPrismaCall(makeCall({ target: "db.user.findMany" }), ctxOther)).toBeNull()
  })

  it("returns null for a bare identifier (no accessor chain)", () => {
    expect(classifyPrismaCall(makeCall({ target: "findMany" }), ctxWithPrisma)).toBeNull()
  })

  it("returns null for two-segment method calls that happen to reuse Prisma verb names", () => {
    expect(classifyPrismaCall(makeCall({ target: "router.create" }), ctxWithPrisma)).toBeNull()
    expect(classifyPrismaCall(makeCall({ target: "list.findMany" }), ctxWithPrisma)).toBeNull()
    expect(classifyPrismaCall(makeCall({ target: "queue.upsert" }), ctxWithPrisma)).toBeNull()
  })

  it("returns null for methods outside the Prisma delegate surface", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.user.executeRaw" }), ctxWithPrisma),
    ).toBeNull()
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.user.someHelper" }), ctxWithPrisma),
    ).toBeNull()
  })

  it("returns null for raw SQL escapes ($queryRaw / $executeRaw / $queryRawUnsafe)", () => {
    expect(classifyPrismaCall(makeCall({ target: "prisma.$queryRaw" }), ctxWithPrisma)).toBeNull()
    expect(classifyPrismaCall(makeCall({ target: "prisma.$executeRaw" }), ctxWithPrisma)).toBeNull()
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.$queryRawUnsafe" }), ctxWithPrisma),
    ).toBeNull()
  })

  it("does not classify `$transactional` — only the exact `$transaction` sentinel", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.$transactional" }), ctxWithPrisma),
    ).toBeNull()
  })

  it("returns null for a bare `$transaction` (no client segment)", () => {
    expect(classifyPrismaCall(makeCall({ target: "$transaction" }), ctxWithPrisma)).toBeNull()
  })

  it("classifies deeply chained services.prisma.$transaction as db.transaction", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "services.prisma.$transaction" }), ctxWithPrisma)
        ?.effectId,
    ).toBe("db.transaction")
  })
})

describe("classifyPrismaCall — malformed input fail-fast", () => {
  const ctxWithPrisma = makeCtx({ imports: [makePrismaImport()] })
  const ctxNoImport = makeCtx({ imports: [] })

  it.each([
    ["", /target is empty/],
    ["prisma..create", /empty segment/],
    [".create", /empty segment/],
    ["prisma.user.", /empty segment/],
  ])("throws for the malformed target %j with or without a Prisma import", (target, message) => {
    expect(() => classifyPrismaCall(makeCall({ target }), ctxWithPrisma)).toThrow(message)
    expect(() => classifyPrismaCall(makeCall({ target }), ctxNoImport)).toThrow(message)
  })

  it("names itself in the message — a transposed plugin-name const would type-check silently", () => {
    expect(() => classifyPrismaCall(makeCall({ target: "" }), ctxWithPrisma)).toThrow(
      /^effects-prisma \(/,
    )
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["PrismaClient"], line: 2, dynamic: false }],
    })
    expect(() =>
      classifyPrismaCall(makeCall({ target: "prisma.user.create" }), brokenEdge),
    ).toThrow(/^effects-prisma \(/)
  })

  it("throw messages include the file path so caught exceptions point at the offending source", () => {
    const ctxWithPath = makeCtx({ imports: [makePrismaImport()], path: "src/services/x.ts" })
    expect(() => classifyPrismaCall(makeCall({ target: "" }), ctxWithPath)).toThrow(
      /src\/services\/x\.ts/,
    )
    expect(() => classifyPrismaCall(makeCall({ target: "prisma..create" }), ctxWithPath)).toThrow(
      /src\/services\/x\.ts/,
    )
  })

  it("throw messages for a broken ImportEdge name the file and the offending line", () => {
    const ctxBrokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["PrismaClient"], line: 4, dynamic: false }],
      path: "src/services/x.ts",
    })
    expect(() =>
      classifyPrismaCall(makeCall({ target: "prisma.user.create" }), ctxBrokenEdge),
    ).toThrow(/ImportEdge\.source is empty/)
    expect(() =>
      classifyPrismaCall(makeCall({ target: "prisma.user.create" }), ctxBrokenEdge),
    ).toThrow(/src\/services\/x\.ts, line 4/)
  })
})

describe("classifyPrismaCall — purity", () => {
  it("does not mutate the input CallCandidate or the observable data slices of ClassifyContext", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.user.findMany", literalArgs: ["value"] })
    const fileSnapshot = structuredClone(ctx.file)
    const ownerSnapshot = structuredClone(ctx.owner)
    const languageSnapshot = ctx.language
    const callSnapshot = structuredClone(call)
    classifyPrismaCall(call, ctx)
    expect(call).toEqual(callSnapshot)
    expect(ctx.file).toEqual(fileSnapshot)
    expect(ctx.owner).toEqual(ownerSnapshot)
    expect(ctx.language).toBe(languageSnapshot)
  })
})

describe("classifyPrismaCall — a model segment that names nothing", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

  it("keeps the write when the receiver names a client, at the tier the flag sets", () => {
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.<computed>.create", dynamicReceiver: true }),
      ctx,
    )
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
  })

  it("reads a computed model on a client reached through a chain", () => {
    expect(
      classifyPrismaCall(
        makeCall({ target: "this.prisma.<computed>.update", dynamicReceiver: true }),
        ctx,
      )?.effectId,
    ).toBe("db.write")
  })

  it("does not let the sentinel buy the delegate shape for an unrelated receiver", () => {
    for (const target of [
      "queues.<computed>.upsert",
      "sets.<computed>.delete",
      "router.<computed>.create",
    ]) {
      expect(classifyPrismaCall(makeCall({ target, dynamicReceiver: true }), ctx)).toBeNull()
    }
  })

  it("returns null when the verb itself is the segment that names nothing", () => {
    // `prisma.user[verb]()` — three segments, a recognized client, and no method to match.
    expect(
      classifyPrismaCall(
        makeCall({ target: "prisma.user.<computed>", dynamicReceiver: true }),
        ctx,
      ),
    ).toBeNull()
  })
})
