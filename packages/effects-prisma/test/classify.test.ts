import { describe, expect, it } from "vitest"
import { classifyPrismaCall } from "../src/index"
import { makeCall, makeCtx, makePrismaImport } from "./fixtures/context"

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
    // Express `router.create(...)`, Array `.findMany` (hypothetical), etc. — files
    // that colocate Prisma alongside these libraries would otherwise false-positive.
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

  it("returns null when the target is empty", () => {
    expect(classifyPrismaCall(makeCall({ target: "" }), ctxWithPrisma)).toBeNull()
  })

  it("does not classify `$transactional` — only the exact `$transaction` sentinel", () => {
    expect(
      classifyPrismaCall(makeCall({ target: "prisma.$transactional" }), ctxWithPrisma),
    ).toBeNull()
  })
})

describe("classifyPrismaCall — purity", () => {
  it("is idempotent: same input yields structurally equal output", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.user.findMany", line: 42, argumentCount: 1 })
    const first = classifyPrismaCall(call, ctx)
    const second = classifyPrismaCall(call, ctx)
    expect(first).toEqual(second)
  })

  it("does not mutate the input CallCandidate or ClassifyContext", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const originalImports = [...ctx.file.imports]
    const call = makeCall({ target: "prisma.user.findMany" })
    const originalCall = { ...call }
    classifyPrismaCall(call, ctx)
    expect(call).toEqual(originalCall)
    expect(ctx.file.imports).toEqual(originalImports)
  })
})
