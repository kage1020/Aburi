import { describe, expect, it } from "vitest"
import { classifyDrizzleCall } from "../src/index"
import { makeCall, makeCtx, makeDrizzleImport } from "./fixtures/context"

describe("classifyDrizzleCall — read terminals", () => {
  const ctx = makeCtx({ imports: [makeDrizzleImport()] })

  it.each([
    "select",
    "selectDistinct",
    "selectDistinctOn",
  ])("classifies db.%s as db.read", (method) => {
    const result = classifyDrizzleCall(makeCall({ target: `db.${method}` }), ctx)
    expect(result?.effectId).toBe("db.read")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:drizzle:read")
  })

  it("accepts arbitrary leading segments (this.db.select)", () => {
    expect(classifyDrizzleCall(makeCall({ target: "this.db.select" }), ctx)?.effectId).toBe(
      "db.read",
    )
  })

  it("accepts deeply chained accessors (container.services.db.select)", () => {
    expect(
      classifyDrizzleCall(makeCall({ target: "container.services.db.select" }), ctx)?.effectId,
    ).toBe("db.read")
  })
})

describe("classifyDrizzleCall — write terminals", () => {
  const ctx = makeCtx({ imports: [makeDrizzleImport()] })

  it.each(["insert", "update", "delete"])("classifies db.%s as db.write", (method) => {
    const result = classifyDrizzleCall(makeCall({ target: `db.${method}` }), ctx)
    expect(result?.effectId).toBe("db.write")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:drizzle:write")
  })
})

describe("classifyDrizzleCall — transaction terminals", () => {
  const ctx = makeCtx({ imports: [makeDrizzleImport()] })

  it("classifies db.transaction (with callback arg) as db.transaction", () => {
    const result = classifyDrizzleCall(
      makeCall({ target: "db.transaction", argumentCount: 1 }),
      ctx,
    )
    expect(result?.effectId).toBe("db.transaction")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:drizzle:tx")
  })

  it("classifies db.batch (with statement array arg) as db.transaction (Neon / D1)", () => {
    const result = classifyDrizzleCall(makeCall({ target: "db.batch", argumentCount: 1 }), ctx)
    expect(result?.effectId).toBe("db.transaction")
    expect(result?.derivedBy).toBe("effects-plugin:drizzle:tx")
  })

  it("throws for db.transaction with argCount=0 — upstream signal, not silent null", () => {
    // The transaction/batch APIs are required to take at least one argument. A
    // shape-matched call with argCount=0 is an upstream bug (broken user code or a
    // malformed CallCandidate from the language plugin); throwing surfaces it rather
    // than silently returning null which would conflate this with "not a Drizzle call".
    expect(() =>
      classifyDrizzleCall(makeCall({ target: "db.transaction", argumentCount: 0 }), ctx),
    ).toThrow(/argCount=0/)
  })

  it("throws for db.batch with argCount=0 for the same reason", () => {
    expect(() =>
      classifyDrizzleCall(makeCall({ target: "db.batch", argumentCount: 0 }), ctx),
    ).toThrow(/argCount=0/)
  })

  it("throw message includes the file path and target for reproducibility", () => {
    const ctxWithPath = makeCtx({
      imports: [makeDrizzleImport()],
      path: "src/services/tx.ts",
    })
    expect(() =>
      classifyDrizzleCall(
        makeCall({ target: "db.transaction", argumentCount: 0, line: 42 }),
        ctxWithPath,
      ),
    ).toThrow(/src\/services\/tx\.ts.*db\.transaction/s)
  })

  it("classifies this.db.transaction as db.transaction", () => {
    expect(
      classifyDrizzleCall(makeCall({ target: "this.db.transaction", argumentCount: 1 }), ctx)
        ?.effectId,
    ).toBe("db.transaction")
  })
})

describe("classifyDrizzleCall — relational query API", () => {
  const ctx = makeCtx({ imports: [makeDrizzleImport()] })

  it.each(["findMany", "findFirst"])("classifies db.query.users.%s as db.read", (method) => {
    const result = classifyDrizzleCall(
      makeCall({ target: `db.query.users.${method}`, argumentCount: 1 }),
      ctx,
    )
    expect(result?.effectId).toBe("db.read")
    expect(result?.derivedBy).toBe("effects-plugin:drizzle:read")
  })

  it("accepts length-5 receiver: this.db.query.users.findMany", () => {
    expect(
      classifyDrizzleCall(
        makeCall({ target: "this.db.query.users.findMany", argumentCount: 1 }),
        ctx,
      )?.effectId,
    ).toBe("db.read")
  })

  it("does NOT match findUnique on the query API (Prisma vocab)", () => {
    expect(
      classifyDrizzleCall(makeCall({ target: "db.query.users.findUnique", argumentCount: 1 }), ctx),
    ).toBeNull()
  })

  it("requires the `.query.` marker at index -3 — table.findMany without it is null", () => {
    // `db.users.findMany` (no `.query.`) is not the relational query shape, and
    // `findMany` is not in the generic terminal vocab either, so returns null.
    expect(classifyDrizzleCall(makeCall({ target: "db.users.findMany" }), ctx)).toBeNull()
  })

  it("requires the table segment — db.query.findMany (3 segments, missing table) is null", () => {
    // 3-segment shape with `query` at index -2 does not match the length-4 gate.
    // The relational query API requires an explicit table segment between `query`
    // and the verb.
    expect(classifyDrizzleCall(makeCall({ target: "db.query.findMany" }), ctx)).toBeNull()
  })
})

describe("classifyDrizzleCall — chain-collapse (one classification per fluent chain)", () => {
  const ctx = makeCtx({ imports: [makeDrizzleImport()] })

  it.each([
    "db.select.from",
    "db.select.from.where",
    "db.select.from.where.orderBy",
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
  ])("rejects fluent-chain link %s (root already classifies)", (target) => {
    // walkBody emits one CallCandidate per link in the chain. Only the ROOT survives —
    // every candidate carrying a root verb as an internal segment must return null so
    // a single SQL statement produces exactly one effect record.
    expect(classifyDrizzleCall(makeCall({ target }), ctx)).toBeNull()
  })

  it("rejects long chains with a root verb deep in the middle", () => {
    expect(
      classifyDrizzleCall(makeCall({ target: "db.select.from.leftJoin.where.orderBy.limit" }), ctx),
    ).toBeNull()
  })
})

describe("classifyDrizzleCall — negative paths", () => {
  const ctxWithDrizzle = makeCtx({ imports: [makeDrizzleImport()] })

  it("returns null when the file does not import drizzle-orm", () => {
    const ctxNoImport = makeCtx({ imports: [] })
    expect(classifyDrizzleCall(makeCall({ target: "db.select" }), ctxNoImport)).toBeNull()
  })

  it("returns null when the file imports a different ORM", () => {
    const ctxOther = makeCtx({
      imports: [{ source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }],
    })
    expect(classifyDrizzleCall(makeCall({ target: "db.select" }), ctxOther)).toBeNull()
  })

  it("returns null for a bare identifier (no accessor chain)", () => {
    expect(classifyDrizzleCall(makeCall({ target: "select" }), ctxWithDrizzle)).toBeNull()
    expect(classifyDrizzleCall(makeCall({ target: "insert" }), ctxWithDrizzle)).toBeNull()
    expect(
      classifyDrizzleCall(makeCall({ target: "transaction", argumentCount: 1 }), ctxWithDrizzle),
    ).toBeNull()
  })

  it("returns null for execute — raw SQL cannot be disambiguated statically", () => {
    // `db.execute(sql`...`)` may be a read or a write. Prisma drops $queryRaw/$executeRaw
    // for the same reason. Users who need raw-SQL effects hand-annotate.
    expect(classifyDrizzleCall(makeCall({ target: "db.execute" }), ctxWithDrizzle)).toBeNull()
    expect(classifyDrizzleCall(makeCall({ target: "this.db.execute" }), ctxWithDrizzle)).toBeNull()
  })

  it("returns null for methods outside the Drizzle terminal vocabulary", () => {
    expect(classifyDrizzleCall(makeCall({ target: "db.someHelper" }), ctxWithDrizzle)).toBeNull()
    expect(classifyDrizzleCall(makeCall({ target: "db.prepare" }), ctxWithDrizzle)).toBeNull()
  })
})

describe("classifyDrizzleCall — malformed input fail-fast", () => {
  const ctxWithDrizzle = makeCtx({ imports: [makeDrizzleImport()] })

  it("throws for an empty target — language plugin contract violation", () => {
    expect(() => classifyDrizzleCall(makeCall({ target: "" }), ctxWithDrizzle)).toThrow(
      /target is empty/,
    )
  })

  it("throws for malformed targets even when the file does not import Drizzle", () => {
    // The import gate must NOT shadow malformed-input detection — otherwise the same
    // upstream bug would surface only in Drizzle-consuming files and stay silent
    // everywhere else. Locking the order at the test seam.
    const ctxNoImport = makeCtx({ imports: [] })
    expect(() => classifyDrizzleCall(makeCall({ target: "" }), ctxNoImport)).toThrow(
      /target is empty/,
    )
    expect(() => classifyDrizzleCall(makeCall({ target: "db..insert" }), ctxNoImport)).toThrow(
      /empty segment/,
    )
    expect(() => classifyDrizzleCall(makeCall({ target: ".select" }), ctxNoImport)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a target with a trailing dot", () => {
    expect(() => classifyDrizzleCall(makeCall({ target: "db.select." }), ctxWithDrizzle)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a target with adjacent dots — otherwise `db..insert` would false-classify as db.write", () => {
    expect(() => classifyDrizzleCall(makeCall({ target: "db..insert" }), ctxWithDrizzle)).toThrow(
      /empty segment/,
    )
  })

  it("names itself in the message — a transposed plugin-name const would type-check silently", () => {
    // The name is now an importable const shared by four packages rather than a literal in
    // this file, so nothing but this assertion catches `EFFECTS_TRPC_PLUGIN_NAME` here.
    expect(() => classifyDrizzleCall(makeCall({ target: "" }), ctxWithDrizzle)).toThrow(
      /^effects-drizzle \(/,
    )
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["drizzle"], line: 2, dynamic: false }],
    })
    expect(() => classifyDrizzleCall(makeCall({ target: "db.select" }), brokenEdge)).toThrow(
      /^effects-drizzle \(/,
    )
  })

  it("throw messages include the file path so caught exceptions point at the offending source", () => {
    const ctxWithPath = makeCtx({ imports: [makeDrizzleImport()], path: "src/services/x.ts" })
    expect(() => classifyDrizzleCall(makeCall({ target: "" }), ctxWithPath)).toThrow(
      /src\/services\/x\.ts/,
    )
    expect(() => classifyDrizzleCall(makeCall({ target: "db..insert" }), ctxWithPath)).toThrow(
      /src\/services\/x\.ts/,
    )
  })
})

describe("classifyDrizzleCall — purity", () => {
  it("is idempotent: same input yields structurally equal output", () => {
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.select", line: 42, argumentCount: 0 })
    const first = classifyDrizzleCall(call, ctx)
    const second = classifyDrizzleCall(call, ctx)
    expect(first).toEqual(second)
  })

  it("does not mutate the input CallCandidate or the observable data slices of ClassifyContext", () => {
    // structuredClone would reject the VocabRegistry's function properties, so clone
    // the data slices the classifier actually reads (file + owner + language) plus the
    // CallCandidate.
    const ctx = makeCtx({ imports: [makeDrizzleImport()] })
    const call = makeCall({ target: "db.insert", argumentCount: 1, literalArgs: ["users"] })
    const fileSnapshot = structuredClone(ctx.file)
    const ownerSnapshot = structuredClone(ctx.owner)
    const languageSnapshot = ctx.language
    const callSnapshot = structuredClone(call)
    classifyDrizzleCall(call, ctx)
    expect(call).toEqual(callSnapshot)
    expect(ctx.file).toEqual(fileSnapshot)
    expect(ctx.owner).toEqual(ownerSnapshot)
    expect(ctx.language).toBe(languageSnapshot)
  })
})
