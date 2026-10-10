import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("bracket-delegate")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

describe("scan — a Prisma delegate addressed through brackets", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const prisma = new PrismaClient()",
        "",
        "export async function createUser(data: unknown) {",
        '  return prisma["user"].create({ data })',
        "}",
        "",
        "export async function createAny(model: string, data: unknown) {",
        "  return prisma[model].create({ data })",
        "}",
        "",
      ].join("\n"),
    )
  })

  it("reads a literal index as the model it spells", async () => {
    const result = await scanWorkspace()
    const create = symbolById(result, "ts:src/repo.ts#createUser")

    expect(
      create.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.write", target: "prisma.user.create", confidence: "high" }])
  })

  it("keeps the write on a computed index, and says the model is not a name", async () => {
    const result = await scanWorkspace()
    const create = symbolById(result, "ts:src/repo.ts#createAny")

    expect(
      create.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.write", target: "prisma.<computed>.create", confidence: "medium" }])
  })

  it("says which model it could not read on the effect, because the call is not in calls[]", async () => {
    const result = await scanWorkspace()
    const create = symbolById(result, "ts:src/repo.ts#createAny")

    expect(create.calls.map((c) => c.target)).not.toContain("prisma.create")
    expect(create.calls.map((c) => c.target)).not.toContain("prisma.<computed>.create")
  })
})

describe("scan — a bracket on something that is not a client", () => {
  it("does not read a Map or a queue as a delegate call", async () => {
    await workspace.writeSource(
      "src/queue.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const prisma = new PrismaClient()",
        "const queues = new Map<string, any>()",
        "const sets = new Map<string, any>()",
        "",
        "export function drain(id: string, item: string) {",
        "  queues[id].upsert({ item })",
        "  sets[id].delete(item)",
        "  return prisma.job.findMany()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const drain = symbolById(result, "ts:src/queue.ts#drain")

    expect(drain.effects.map((e) => e.target)).toEqual(["prisma.job.findMany"])
    // They are still calls, with the segment saying what the source computed.
    expect(drain.calls.map((c) => c.target)).toEqual([
      "queues.<computed>.upsert",
      "sets.<computed>.delete",
    ])
  })
})
