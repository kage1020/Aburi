import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { drizzleEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("drizzle-call-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [drizzleEffectsPlugin] })

describe("scan — Drizzle calls in a service file", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { drizzle } from "drizzle-orm/postgres-js"',
        'import { users } from "./schema"',
        "",
        "type Db = ReturnType<typeof drizzle>",
        "",
        "export async function listUsers(db: Db) {",
        '  report("listing")',
        "  return await db.select().from(users).where(undefined).orderBy(undefined)",
        "}",
        "",
        "export async function createUser(db: Db) {",
        '  return await db.insert(users).values({ name: "x" }).returning()',
        "}",
        "",
        "export async function renameUser(db: Db) {",
        '  return await db.update(users).set({ name: "y" }).where(undefined)',
        "}",
        "",
        "export async function removeAll(db: Db) {",
        "  return await db.delete(",
        "    users, // soft delete is not used here",
        "  )",
        "}",
        "",
        "export async function listByGateway(gateway: Db) {",
        "  return await gateway.select().from(users)",
        "}",
        "",
        "export async function listWithPosts(db: Db) {",
        "  return await db.query.users.findMany({ limit: 10 })",
        "}",
        "",
        "export class UserService {",
        "  constructor(private readonly db: Db) {}",
        "  async first() {",
        "    return await this.db.query.users.findFirst()",
        "  }",
        "}",
        "",
        "export async function moveUser(db: Db) {",
        "  return db.transaction(async (tx) => {",
        '    return tx.insert(users).values({ name: "z" })',
        "  })",
        "}",
        "",
        "export async function bulk(db: Db) {",
        "  return await db.batch([",
        '    db.insert(users).values({ name: "a" }),',
        '    db.insert(users).values({ name: "b" }),',
        "  ])",
        "}",
        "",
      ].join("\n"),
    )
  })

  it("records one effect per fluent chain, on the call at its root", async () => {
    const result = await scanWorkspace()

    expect(symbolNamed(result, "listUsers").effects).toMatchObject([
      {
        id: "db.read",
        target: "db.select",
        confidence: "high",
        derivedBy: "effects-plugin:drizzle:read",
      },
    ])
    expect(symbolNamed(result, "createUser").effects).toMatchObject([
      { id: "db.write", target: "db.insert", derivedBy: "effects-plugin:drizzle:write" },
    ])
    expect(symbolNamed(result, "renameUser").effects).toMatchObject([
      { id: "db.write", target: "db.update" },
    ])
  })

  it("keeps a write whose argument list carries a comment at high", async () => {
    const result = await scanWorkspace()

    expect(symbolNamed(result, "removeAll").effects).toMatchObject([
      { id: "db.write", target: "db.delete", confidence: "high" },
    ])
  })

  it("records a query on a binding it does not recognize at medium rather than dropping it", async () => {
    const result = await scanWorkspace()

    expect(symbolNamed(result, "listByGateway").effects).toMatchObject([
      { id: "db.read", target: "gateway.select", confidence: "medium" },
    ])
  })

  it("reads the relational query API, on a parameter or on a field, as db.read", async () => {
    const result = await scanWorkspace()

    expect(symbolNamed(result, "listWithPosts").effects).toMatchObject([
      { id: "db.read", target: "db.query.users.findMany", confidence: "high" },
    ])
    expect(symbolNamed(result, "UserService.first").effects).toMatchObject([
      { id: "db.read", target: "this.db.query.users.findFirst", confidence: "high" },
    ])
  })

  it("records a transaction or a batch beside the writes inside it", async () => {
    const result = await scanWorkspace()

    expect(symbolNamed(result, "moveUser").effects).toMatchObject([
      { id: "db.transaction", target: "db.transaction", derivedBy: "effects-plugin:drizzle:tx" },
      { id: "db.write", target: "tx.insert", confidence: "high" },
    ])
    expect(symbolNamed(result, "bulk").effects).toMatchObject([
      { id: "db.transaction", target: "db.batch" },
      { id: "db.write", target: "db.insert" },
      { id: "db.write", target: "db.insert" },
    ])
  })
})

describe("scan — a file that does not import drizzle-orm", () => {
  it("records nothing, though the calls are spelled like Drizzle's", async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export async function listUsers(db: PrismaClient) {",
        "  return db.select().from(users)",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
    expect(symbolNamed(result, "listUsers").calls.map((c) => c.target)).toContain("db.select")
  })
})
