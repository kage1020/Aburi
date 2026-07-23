import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
  walkBody as walkTypescriptBody,
} from "@aburi/lang-typescript"
import type {
  ExtractionContext,
  ImportEdge,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifyDrizzleCall } from "../src/index"
import { makeOwner, noopRegistry } from "./fixtures/context"

/**
 * End-to-end: parse a TypeScript source through `@aburi/lang-typescript`, walk each
 * Symbol's body to produce CallCandidate[], and confirm that the Drizzle classifier
 * assigns the right effect ids per call. Locks the wire between call extraction in the
 * language plugin and effect classification here — especially the
 * one-classification-per-fluent-chain invariant that is central to this package.
 */

async function classifyCalls(
  path: string,
  source: string,
  imports: ImportEdge[] = [{ source: "drizzle-orm", symbols: ["sql"], line: 1, dynamic: false }],
) {
  const parseResult = await parseTypescriptFile({ path, content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path, content: source }
  const extractCtx: ExtractionContext = { file, registry: noopRegistry, config: {} }
  const candidates: SymbolCandidate<Node>[] = extractTypescriptSymbols(tree, extractCtx)
  const results: Array<{
    symbolName: string
    target: string
    effectId: string | null
    derivedBy: string | null
  }> = []
  for (const symbol of candidates) {
    const walkCtx: WalkContext<Node> = { ...extractCtx, symbol }
    const { calls } = walkTypescriptBody(symbol, walkCtx)
    for (const call of calls) {
      const classification = classifyDrizzleCall(call, {
        owner: makeOwner({ id: symbol.id, name: symbol.name, kind: symbol.kind }),
        file: { path, imports },
        language: "ts",
        registry: noopRegistry,
        config: {},
      })
      results.push({
        symbolName: symbol.name,
        target: call.target,
        effectId: classification?.effectId ?? null,
        derivedBy: classification?.derivedBy ?? null,
      })
    }
  }
  return results
}

describe("integration — lang-typescript walkBody → effects-drizzle classify", () => {
  it("classifies a bare db.select().from(users) chain as exactly one db.read (chain-collapse)", async () => {
    // The core invariant: a single SQL query, no matter how many `.from`/`.where`/...
    // links it has, must yield exactly ONE effect record. walkBody emits one candidate
    // per link; the classifier drops every downstream link so the count matches.
    const results = await classifyCalls(
      "src/services/users.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function listUsers(db: ReturnType<typeof drizzle>) {
  return await db.select().from(users).where(undefined).orderBy(undefined)
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const reads = results.filter((r) => r.effectId === "db.read")
    expect(reads).toHaveLength(1)
    expect(reads[0]?.target).toBe("db.select")
    expect(reads[0]?.derivedBy).toBe("effects-plugin:drizzle:read")
  })

  it("classifies a write chain db.insert(users).values({...}).returning() as exactly one db.write", async () => {
    const results = await classifyCalls(
      "src/services/users.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function createUser(db: ReturnType<typeof drizzle>) {
  return await db.insert(users).values({ name: "x" }).returning()
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const writes = results.filter((r) => r.effectId === "db.write")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.target).toBe("db.insert")
  })

  it("classifies an update chain db.update(users).set(...).where(...) as exactly one db.write", async () => {
    const results = await classifyCalls(
      "src/services/users.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function renameUser(db: ReturnType<typeof drizzle>) {
  return await db.update(users).set({ name: "y" }).where(undefined)
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const writes = results.filter((r) => r.effectId === "db.write")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.target).toBe("db.update")
  })

  it("classifies the relational query API db.query.users.findMany() as db.read (length-4)", async () => {
    const results = await classifyCalls(
      "src/services/relational.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
export async function listUsers(db: ReturnType<typeof drizzle>) {
  return await db.query.users.findMany({ limit: 10 })
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const call = results.find((r) => r.target === "db.query.users.findMany")
    expect(call?.effectId).toBe("db.read")
  })

  it("classifies this.db.query.users.findFirst inside a class method (length-5)", async () => {
    const results = await classifyCalls(
      "src/services/UserService.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
export class UserService {
  constructor(private readonly db: ReturnType<typeof drizzle>) {}
  async first() {
    return await this.db.query.users.findFirst()
  }
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const call = results.find((r) => r.target === "this.db.query.users.findFirst")
    expect(call?.effectId).toBe("db.read")
  })

  it("classifies db.transaction(async tx => tx.insert(users).values(...)) as tx + inner write", async () => {
    // The callback form is the interactive-transaction idiom. Both the outer
    // db.transaction and the inner tx.insert appear as separate CallCandidates; the
    // outer classifies as db.transaction, the inner as db.write. Chain-collapse still
    // applies inside the callback body: `tx.insert.values` is dropped.
    const results = await classifyCalls(
      "src/services/tx.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function moveUser(db: ReturnType<typeof drizzle>) {
  return db.transaction(async (tx) => {
    return tx.insert(users).values({ name: "z" })
  })
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const outerTx = results.find((r) => r.target === "db.transaction")
    const innerWrite = results.find((r) => r.target === "tx.insert")
    expect(outerTx?.effectId).toBe("db.transaction")
    expect(innerWrite?.effectId).toBe("db.write")
    const writeCount = results.filter((r) => r.effectId === "db.write").length
    expect(writeCount).toBe(1)
  })

  it("leaves non-Drizzle calls unclassified even when Drizzle is imported", async () => {
    const results = await classifyCalls(
      "src/services/mixed.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
export async function work(db: ReturnType<typeof drizzle>) {
  console.log("hello")
  return await db.select().from(undefined)
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const logCall = results.find((r) => r.target === "console.log")
    const drizzleRead = results.find((r) => r.target === "db.select")
    expect(logCall?.effectId).toBeNull()
    expect(drizzleRead?.effectId).toBe("db.read")
  })

  it("returns null for every call when drizzle-orm is not imported (cross-plugin non-interference)", async () => {
    // A Prisma-only file: `db.select` shape exists but with a non-Drizzle import.
    // Drizzle must not classify — leaves the call for the Prisma classifier upstream.
    const results = await classifyCalls(
      "src/services/prisma-only.ts",
      `import { PrismaClient } from "@prisma/client"
export async function listUsers(prisma: PrismaClient) {
  return prisma.user.findMany()
}`,
      [{ source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }],
    )
    for (const r of results) {
      expect(r.effectId).toBeNull()
    }
  })

  it("emits derivedBy under the shared effects-plugin:drizzle prefix", async () => {
    const results = await classifyCalls(
      "src/services/prefix-check.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function work(db: ReturnType<typeof drizzle>) {
  await db.select().from(users)
  await db.insert(users).values({})
  await db.transaction(async () => {})
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    for (const r of results.filter((r) => r.derivedBy !== null)) {
      expect(r.derivedBy?.startsWith("effects-plugin:drizzle:")).toBe(true)
    }
  })
})
