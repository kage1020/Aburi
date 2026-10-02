import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A handler map — behaviour grouped under one exported constant — had no Symbol for any of its
 * handlers: the constant was a `const` with no body, so a write inside a handler was reported
 * nowhere, an edit to one moved no fingerprint, and a call through the map resolved to nothing.
 * This runs the real pipeline.
 */

const workspace = useScratchWorkspace("object-of-handlers")

const lineup = { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] }

const api = (remove: string[]) =>
  [
    'import { PrismaClient } from "@prisma/client"',
    "",
    "const prisma = new PrismaClient()",
    "",
    "export const users = {",
    "  list: async () => prisma.user.findMany(),",
    "  remove(id: number) {",
    ...remove.map((line) => `    ${line}`),
    "  },",
    "}",
    "",
  ].join("\n")

const DELETE = [
  'if (!id) throw new Error("missing id")',
  "return prisma.user.delete({ where: { id } })",
]
const SOFT_DELETE = ["return prisma.user.update({ where: { id }, data: { deleted: true } })"]

const ROUTE = [
  'import { users } from "./users"',
  "",
  "export async function handle(id: number) {",
  "  return users.remove(id)",
  "}",
  "",
].join("\n")

describe("scan — a handler map", () => {
  it("puts each handler's rules and effects on the handler, and none on the map", async () => {
    await workspace.writeSource("src/users.ts", api(DELETE))
    const result = await scanWith(workspace.root, lineup)
    const remove = symbolById(result, "ts:src/users.ts#users.remove")
    const list = symbolById(result, "ts:src/users.ts#users.list")
    const map = symbolById(result, "ts:src/users.ts#users")

    expect(remove.kind).toBe("method")
    expect(remove.rules.map((r) => r.type)).toEqual(["guard", "throw"])
    expect(remove.effects.map((e) => [e.id, e.target])).toEqual([
      ["db.write", "prisma.user.delete"],
    ])
    expect(list.effects.map((e) => [e.id, e.target])).toEqual([["db.read", "prisma.user.findMany"]])
    expect(map.kind).toBe("const")
    expect(map.effects).toEqual([])
  })

  it("resolves a call through the map to the handler, and carries its write to the caller", async () => {
    await workspace.writeSource("src/users.ts", api(DELETE))
    await workspace.writeSource("src/route.ts", ROUTE)
    const result = await scanWith(workspace.root, lineup)
    const handle = symbolById(result, "ts:src/route.ts#handle")

    expect(handle.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["users.remove", "ts:src/users.ts#users.remove"],
    ])
    expect(handle.effects.map((e) => e.id)).toContain("db.write")
  })

  it("reports an edit to one handler as its logic change, and the map's as syntax only", async () => {
    // The map is described by its whole declaration, as it was while it had no body, so the
    // edit is in its syntax — as a method's edit is in its class's, whose string is the
    // `class_body`. Its logic is what defining the object runs, which the edit does not touch.
    await workspace.writeSource("src/users.ts", api(DELETE))
    const baseIR = (await scanWith(workspace.root, lineup)).ir
    await workspace.writeSource("src/users.ts", api(SOFT_DELETE))
    const headIR = (await scanWith(workspace.root, lineup)).ir
    const changes = diffIRs(baseIR, headIR).symbols

    expect(
      changes.map((change) =>
        change.status === "changed"
          ? [change.after.name, change.delta.logicChanged, change.delta.syntaxChanged]
          : [change.status],
      ),
    ).toEqual([
      ["users", false, true],
      ["users.remove", true, true],
    ])
  })
})
