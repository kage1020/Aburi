import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("prisma-call-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

describe("scan — Prisma calls in a service file", () => {
  it("records each delegate verb and $transaction on the function that makes the call", async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export async function listUsers(prisma: PrismaClient) {",
        '  report("listing")',
        "  return prisma.user.findMany()",
        "}",
        "",
        "export async function createInvoice(prisma: PrismaClient, data: unknown) {",
        "  return prisma.invoice.create({ data })",
        "}",
        "",
        "export async function moveUser(prisma: PrismaClient) {",
        "  return prisma.$transaction(async (tx) => {",
        "    return tx.user.create({ data: {} })",
        "  })",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    const listUsers = symbolNamed(result, "listUsers")
    expect(listUsers.effects).toMatchObject([
      {
        id: "db.read",
        target: "prisma.user.findMany",
        confidence: "high",
        derivedBy: "effects-plugin:prisma:read",
      },
    ])
    expect(listUsers.calls.map((c) => c.target)).toEqual(["report"])
    expect(symbolNamed(result, "createInvoice").effects).toMatchObject([
      { id: "db.write", target: "prisma.invoice.create", derivedBy: "effects-plugin:prisma:write" },
    ])
    expect(symbolNamed(result, "moveUser").effects).toMatchObject([
      {
        id: "db.transaction",
        target: "prisma.$transaction",
        derivedBy: "effects-plugin:prisma:tx",
      },
      { id: "db.write", target: "tx.user.create", confidence: "high" },
    ])
  })

  it("keeps a write whose argument list carries a comment", async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export async function removeUser(prisma: PrismaClient, id: string) {",
        "  return prisma.user.delete(",
        "    // hard delete: the row has no soft-delete column",
        "    { where: { id } },",
        "  )",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "removeUser").effects).toMatchObject([
      { id: "db.write", target: "prisma.user.delete", confidence: "high" },
    ])
  })

  it("records nothing in a file that does not import @prisma/client", async () => {
    await workspace.writeSource(
      "src/users.ts",
      [
        'import { db } from "./db"',
        "",
        "export async function listUsers() {",
        "  return db.user.findMany()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
    expect(symbolNamed(result, "listUsers").calls.map((c) => c.target)).toEqual([
      "db.user.findMany",
    ])
  })
})

describe("scan — a Map beside the client that shares the delegate verbs", () => {
  it("records a Map delete at medium and the client's own delete at high", async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class Repo {",
        "  private prisma = new PrismaClient()",
        "  private cache = { items: new Map<string, string>() }",
        "  evict(key: string) {",
        "    this.cache.items.delete(key)",
        "  }",
        "  async removeUser(id: string) {",
        "    return this.prisma.user.delete({ where: { id } })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "Repo.evict").effects).toMatchObject([
      { id: "db.write", target: "this.cache.items.delete", confidence: "medium" },
    ])
    expect(symbolNamed(result, "Repo.removeUser").effects).toMatchObject([
      { id: "db.write", target: "this.prisma.user.delete", confidence: "high" },
    ])
  })

  it("leaves a delete keyed by a literal, quoted or in backticks, as a call", async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class Repo {",
        "  private prisma = new PrismaClient()",
        "  private cache = { items: new Map<string, string>() }",
        "  evictSession(id: string) {",
        '    this.cache.items.delete("session")',
        "    this.cache.items.delete(`session`)",
        `    this.cache.items.delete(\`session:\${id}\`)`,
        "  }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const evictSession = symbolNamed(result, "Repo.evictSession")

    expect(evictSession.calls.map((c) => [c.target, c.line])).toEqual([
      ["this.cache.items.delete", 7],
      ["this.cache.items.delete", 8],
    ])
    expect(evictSession.effects).toMatchObject([
      { id: "db.write", target: "this.cache.items.delete", line: 9, confidence: "medium" },
    ])
  })
})
