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

  it("returns null for raw SQL escapes ($queryRaw / $executeRaw / $queryRawUnsafe)", () => {
    // These are Prisma Client methods, but they do not fit the model.<verb> shape and
    // they are deliberately not classified. Locking as regression pins so a future
    // change that adds them cannot silently start matching them here first.
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
    // Naked `$transaction()` is not a Prisma call — the transaction API is a method on
    // the client. Locking the 2-segment minimum for the transaction path.
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

  it("throws for an empty target — language plugin contract violation", () => {
    expect(() => classifyPrismaCall(makeCall({ target: "" }), ctxWithPrisma)).toThrow(
      /target is empty/,
    )
  })

  it("throws for malformed targets even when the file does not import Prisma", () => {
    // The import gate must NOT shadow malformed-input detection — otherwise the same
    // upstream bug would surface only in Prisma-consuming files and stay silent
    // everywhere else. Locking the order at the test seam.
    const ctxNoImport = makeCtx({ imports: [] })
    expect(() => classifyPrismaCall(makeCall({ target: "" }), ctxNoImport)).toThrow(
      /target is empty/,
    )
    expect(() => classifyPrismaCall(makeCall({ target: "prisma..create" }), ctxNoImport)).toThrow(
      /empty segment/,
    )
    expect(() => classifyPrismaCall(makeCall({ target: ".create" }), ctxNoImport)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a target with a leading dot (empty first segment)", () => {
    expect(() => classifyPrismaCall(makeCall({ target: ".create" }), ctxWithPrisma)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a target with a trailing dot", () => {
    expect(() => classifyPrismaCall(makeCall({ target: "prisma.user." }), ctxWithPrisma)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a target with adjacent dots — otherwise `prisma..create` would false-classify as db.write", () => {
    expect(() => classifyPrismaCall(makeCall({ target: "prisma..create" }), ctxWithPrisma)).toThrow(
      /empty segment/,
    )
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
  it("is idempotent: same input yields structurally equal output", () => {
    const ctx = makeCtx({ imports: [makePrismaImport()] })
    const call = makeCall({ target: "prisma.user.findMany", line: 42, argumentCount: 1 })
    const first = classifyPrismaCall(call, ctx)
    const second = classifyPrismaCall(call, ctx)
    expect(first).toEqual(second)
  })

  it("does not mutate the input CallCandidate or the observable data slices of ClassifyContext", () => {
    // structuredClone would reject the VocabRegistry's function properties, so clone
    // the data slices the classifier actually reads (file + owner + language) plus the
    // CallCandidate. If any of those change, we know the classifier mutated its input.
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
