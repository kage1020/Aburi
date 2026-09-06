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

describe("classifyPrismaCall — receiver identification", () => {
  const ctx = makeCtx({ imports: [makePrismaImport()] })

  it("does not claim `high` for a Map call that shares the delegate vocabulary", () => {
    // The bug this suite exists for: a repository that holds both a PrismaClient and a
    // plain `Map` cache made `this.cache.items.delete(key)` a high-confidence db.write,
    // because the file imports Prisma and the target has three segments and a write verb.
    // The receiver is what separates them, so the receiver is what sets the tier.
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
    // A client bound under a house convention (`this.repo.user.create`) is not
    // distinguishable from an unrelated object with the same shape, so the effect is
    // recorded with the uncertainty stated rather than dropped.
    const result = classifyPrismaCall(makeCall({ target: "this.repo.user.create" }), ctx)
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
    expect(result?.derivedBy).toBe("effects-plugin:prisma:write")
  })

  it("caps a dynamic receiver at medium", () => {
    // `getPrisma().user.create()` normalizes to `getPrisma.user.create`. The name is a
    // collapsed expression rather than a binding, so it is not evidence of a client.
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
    // `map.delete("session")` / `set.delete("id")`: a Prisma delegate takes an options
    // object or nothing, so a literal first argument rules the call out entirely rather
    // than leaving it to the receiver's name.
    expect(
      classifyPrismaCall(
        makeCall({ target: "this.cache.items.delete", argumentCount: 1, literalArgs: ["session"] }),
        ctx,
      ),
    ).toBeNull()
  })

  it("downgrades a delegate verb called with two arguments rather than dropping it", () => {
    // A delegate takes one options object, so a second argument is evidence against — but
    // `argumentCount` is a syntactic count (a comment inside the parentheses used to
    // inflate it), and a miscount that erases a write logs nothing at all. The tier pays
    // for the doubt instead.
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.user.update", argumentCount: 2, literalArgs: [null, null] }),
      ctx,
    )
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("medium")
  })

  it("keeps a write whose argument list carries a comment", () => {
    // `prisma.user.delete(\n  // hard delete\n  { where: { id } },\n)` reached this
    // classifier as argumentCount=2 before `walkBody` stopped counting comments; the
    // effect survives either way now.
    const result = classifyPrismaCall(
      makeCall({ target: "prisma.user.delete", argumentCount: 1, literalArgs: [null] }),
      ctx,
    )
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("high")
  })

  it("leaves $transaction's own argument shapes alone", () => {
    // `$transaction(fn, { timeout })` takes two arguments, which the delegate shape check
    // would reject — the transaction branch deliberately does not run it.
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

  it("names itself in the message — a transposed plugin-name const would type-check silently", () => {
    // The name is now an importable const shared by four packages rather than a literal in
    // this file, so nothing but this assertion catches `EFFECTS_DRIZZLE_PLUGIN_NAME` here.
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
