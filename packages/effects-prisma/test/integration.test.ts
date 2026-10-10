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
import { classifyPrismaCall } from "../src/index"

async function classifyCalls(
  path: string,
  source: string,
  imports: ImportEdge[] = [
    { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false },
  ],
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
    confidence: string | null
    derivedBy: string | null
  }> = []
  for (const symbol of candidates) {
    const walkCtx: WalkContext<Node> = { ...extractCtx, symbol }
    const { calls } = walkTypescriptBody(symbol, walkCtx)
    for (const call of calls) {
      const classification = classifyPrismaCall(call, {
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

describe("integration — lang-typescript walkBody → effects-prisma classify", () => {
  it("classifies prisma.<model>.findMany inside a service function as db.read", async () => {
    const results = await classifyCalls(
      "src/services/user-service.ts",
      `import { PrismaClient } from "@prisma/client"
export async function listUsers(prisma: PrismaClient) {
  return prisma.user.findMany()
}`,
    )
    const call = results.find((r) => r.target === "prisma.user.findMany")
    expect(call?.effectId).toBe("db.read")
    expect(call?.derivedBy).toBe("effects-plugin:prisma:read")
  })

  it("classifies prisma.<model>.create as db.write", async () => {
    const results = await classifyCalls(
      "src/services/invoice-service.ts",
      `import { PrismaClient } from "@prisma/client"
export async function createInvoice(prisma: PrismaClient, data: unknown) {
  return prisma.invoice.create({ data })
}`,
    )
    const call = results.find((r) => r.target === "prisma.invoice.create")
    expect(call?.effectId).toBe("db.write")
  })

  it("classifies prisma.$transaction as db.transaction", async () => {
    const results = await classifyCalls(
      "src/services/transfer.ts",
      `import { PrismaClient } from "@prisma/client"
export async function transfer(prisma: PrismaClient) {
  return prisma.$transaction([])
}`,
    )
    const call = results.find((r) => r.target === "prisma.$transaction")
    expect(call?.effectId).toBe("db.transaction")
  })

  it("classifies this.prisma.<model>.findMany inside a class method", async () => {
    const results = await classifyCalls(
      "src/services/UserService.ts",
      `import { PrismaClient } from "@prisma/client"
export class UserService {
  constructor(private readonly prisma: PrismaClient) {}
  async list() {
    return this.prisma.user.findMany()
  }
}`,
    )
    const call = results.find((r) => r.target === "this.prisma.user.findMany")
    expect(call?.effectId).toBe("db.read")
  })

  it("leaves non-Prisma calls unclassified even when Prisma is imported", async () => {
    const results = await classifyCalls(
      "src/services/mixed.ts",
      `import { PrismaClient } from "@prisma/client"
export async function work(prisma: PrismaClient) {
  console.log("hello")
  return prisma.user.findMany()
}`,
    )
    const logCall = results.find((r) => r.target === "console.log")
    const prismaCall = results.find((r) => r.target === "prisma.user.findMany")
    expect(logCall?.effectId).toBeNull()
    expect(prismaCall?.effectId).toBe("db.read")
  })

  it("returns null for every call when @prisma/client is not imported", async () => {
    const results = await classifyCalls(
      "src/services/other-orm.ts",
      `import { db } from "./db"
export async function listUsers() {
  return db.user.findMany()
}`,
      [{ source: "./db", symbols: ["db"], line: 1, dynamic: false }],
    )
    for (const r of results) {
      expect(r.effectId).toBeNull()
    }
  })

  it("classifies inner tx callback calls (tx.user.create inside $transaction) as db.write", async () => {
    const results = await classifyCalls(
      "src/services/tx.ts",
      `import { PrismaClient } from "@prisma/client"
export async function moveUser(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    return tx.user.create({ data: {} })
  })
}`,
    )
    const outerTx = results.find((r) => r.target === "prisma.$transaction")
    const innerCall = results.find((r) => r.target === "tx.user.create")
    expect(outerTx?.effectId).toBe("db.transaction")
    expect(innerCall?.effectId).toBe("db.write")
  })

  it("does not fabricate a high-confidence db.write for a Map beside the client", async () => {
    const results = await classifyCalls(
      "src/cache.ts",
      `import { PrismaClient } from "@prisma/client"
export class Repo {
  private prisma = new PrismaClient()
  private cache = { items: new Map<string, string>() }
  async evict(key: string) {
    this.cache.items.delete(key)
    return true
  }
  async removeUser(id: string) {
    return this.prisma.user.delete({ where: { id } })
  }
}`,
    )
    const evicted = results.find((r) => r.target === "this.cache.items.delete")
    expect(evicted?.effectId).toBe("db.write")
    expect(evicted?.confidence).toBe("medium")
    const removed = results.find((r) => r.target === "this.prisma.user.delete")
    expect(removed?.effectId).toBe("db.write")
    expect(removed?.confidence).toBe("high")
  })

  it("keeps a write whose argument list carries a comment", async () => {
    const results = await classifyCalls(
      "src/services/commented.ts",
      `import { PrismaClient } from "@prisma/client"
export async function removeUser(prisma: PrismaClient, id: string) {
  return prisma.user.delete(
    // hard delete: the row has no soft-delete column
    { where: { id } },
  )
}`,
    )
    const write = results.find((r) => r.target === "prisma.user.delete")
    expect(write?.effectId).toBe("db.write")
    expect(write?.confidence).toBe("high")
  })

  it("drops a Map delete keyed by a literal outright", async () => {
    const results = await classifyCalls(
      "src/cache-literal.ts",
      `import { PrismaClient } from "@prisma/client"
export class Repo {
  private prisma = new PrismaClient()
  private cache = { items: new Map<string, string>() }
  evictSession() {
    this.cache.items.delete("session")
  }
}`,
    )
    const evicted = results.find((r) => r.target === "this.cache.items.delete")
    expect(evicted).toBeDefined()
    expect(evicted?.effectId).toBeNull()
  })

  it("drops a Map delete keyed by a backtick literal, as by a quoted one", async () => {
    // A template with no substitution is the same literal (`calls[].literalArgs`), so the veto
    // reads it. One with a substitution is not a literal — its value is decided when it runs —
    // and is classified as `delete(key)` is: recorded, at medium.
    const results = await classifyCalls(
      "src/cache-template.ts",
      `import { PrismaClient } from "@prisma/client"
export class Repo {
  private prisma = new PrismaClient()
  private cache = { items: new Map<string, string>() }
  evictSession(id: string) {
    this.cache.items.delete(\`session\`)
    this.cache.items.delete(\`session:\${id}\`)
  }
}`,
    )
    const [fixed, computed] = results.filter((r) => r.target === "this.cache.items.delete")
    expect(fixed?.effectId).toBeNull()
    expect(computed?.effectId).toBe("db.write")
    expect(computed?.confidence).toBe("medium")
  })

  it("emits derivedBy under the shared effects-plugin:prisma prefix", async () => {
    const results = await classifyCalls(
      "src/services/prefix-check.ts",
      `import { PrismaClient } from "@prisma/client"
export async function work(prisma: PrismaClient) {
  await prisma.user.findMany()
  await prisma.user.create({ data: {} })
  await prisma.$transaction([])
}`,
    )
    for (const r of results.filter((r) => r.derivedBy !== null)) {
      expect(r.derivedBy?.startsWith("effects-plugin:prisma:")).toBe(true)
    }
  })
})
