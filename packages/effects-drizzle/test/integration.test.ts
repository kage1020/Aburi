import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
  walkBody as walkTypescriptBody,
} from "@aburi/lang-typescript"
import { makeOwner, noopRegistry } from "@aburi/test-support"
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

async function classifyCalls(path: string, source: string, imports: ImportEdge[]) {
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
    confidence: string | null
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
        confidence: classification?.confidence ?? null,
        derivedBy: classification?.derivedBy ?? null,
      })
    }
  }
  return results
}

describe("integration — lang-typescript walkBody → effects-drizzle classify", () => {
  it("classifies a bare db.select().from(users) chain as exactly one db.read (chain-collapse)", async () => {
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

  it("leaves a class's own zero-argument update() and a form's delete() unclassified", async () => {
    // Every Drizzle write terminal takes a table, so the zero-argument calls are not Drizzle's,
    // whatever the receiver; `db.update(users)` beside them still classifies.
    const results = await classifyCalls(
      "src/services/profile-form.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export class ProfileForm {
  constructor(private readonly db: ReturnType<typeof drizzle>, private readonly form: { delete(): void }) {}
  update() {}
  async save(name: string) {
    this.update()
    this.form.delete()
    await this.db.update(users).set({ name })
  }
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const effectOf = (target: string) => results.find((r) => r.target === target)?.effectId
    expect(effectOf("this.update")).toBeNull()
    expect(effectOf("this.form.delete")).toBeNull()
    expect(effectOf("this.db.update")).toBe("db.write")
  })

  it("returns null for every call when drizzle-orm is not imported (cross-plugin non-interference)", async () => {
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

  it("classifies db.batch([...]) (Neon / D1 multi-statement API) as db.transaction", async () => {
    const results = await classifyCalls(
      "src/services/batch.ts",
      `import { drizzle } from "drizzle-orm/neon-http"
import { users } from "./schema"
export async function bulk(db: ReturnType<typeof drizzle>) {
  return await db.batch([
    db.insert(users).values({ name: "a" }),
    db.insert(users).values({ name: "b" }),
  ])
}`,
      [{ source: "drizzle-orm/neon-http", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const batchCall = results.find((r) => r.target === "db.batch")
    expect(batchCall?.effectId).toBe("db.transaction")
    // The two inner db.insert(...) roots each classify independently as db.write.
    // Chain-collapse still applies: db.insert.values links are dropped.
    const writes = results.filter((r) => r.effectId === "db.write")
    expect(writes).toHaveLength(2)
    for (const w of writes) expect(w.target).toBe("db.insert")
  })

  it("does not classify an Express route registration beside the queries", async () => {
    const results = await classifyCalls(
      "src/routes/users.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import type { Router } from "express"
import { users } from "./schema"
export function mountUserRoutes(router: Router, db: ReturnType<typeof drizzle>) {
  router.delete("/users/:id", async (req, res) => {
    await db.delete(users)
    res.json({ ok: true })
  })
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const route = results.find((r) => r.target === "router.delete")
    expect(route).toBeDefined()
    expect(route?.effectId).toBeNull()
    const write = results.find((r) => r.target === "db.delete")
    expect(write?.effectId).toBe("db.write")
    expect(write?.confidence).toBe("high")
  })

  it("does not classify a route registration whose path is written in backticks", async () => {
    // The same path in other quotes. A template with no substitution reaches
    // `calls[].literalArgs` as the string it spells, so the literal-first-argument veto reads
    // it; before, it was no literal at all and the route was a medium-confidence db.write.
    const results = await classifyCalls(
      "src/routes/users.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import type { Router } from "express"
export function mountUserRoutes(router: Router) {
  router.delete(\`/users/:id\`, async (req, res) => {
    res.json({ ok: true })
  })
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const route = results.find((r) => r.target === "router.delete")
    expect(route).toBeDefined()
    expect(route?.effectId).toBeNull()
  })

  it("keeps a write whose argument list carries a comment", async () => {
    const results = await classifyCalls(
      "src/services/commented.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function removeAll(db: ReturnType<typeof drizzle>) {
  return await db.delete(
    users, // soft delete is not used here
  )
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const write = results.find((r) => r.target === "db.delete")
    expect(write?.effectId).toBe("db.write")
    expect(write?.confidence).toBe("high")
  })

  it("records a query on an unrecognized binding at medium rather than dropping it", async () => {
    const results = await classifyCalls(
      "src/services/house-style.ts",
      `import { drizzle } from "drizzle-orm/postgres-js"
import { users } from "./schema"
export async function listUsers(gateway: ReturnType<typeof drizzle>) {
  return await gateway.select().from(users)
}`,
      [{ source: "drizzle-orm/postgres-js", symbols: ["drizzle"], line: 1, dynamic: false }],
    )
    const read = results.find((r) => r.target === "gateway.select")
    expect(read?.effectId).toBe("db.read")
    expect(read?.confidence).toBe("medium")
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
    for (const row of results.filter((r) => r.derivedBy !== null)) {
      expect(row.derivedBy?.startsWith("effects-plugin:drizzle:")).toBe(true)
    }
  })
})
