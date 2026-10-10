import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("route-handler")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
    effects: [prismaEffectsPlugin],
  })

describe("scan — an Express route whose handler writes to a database", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/app.ts",
      [
        'import express from "express"',
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const app = express()",
        "const prisma = new PrismaClient()",
        "",
        'app.post("/users", async (req, res) => {',
        "  const user = await prisma.user.create({ data: req.body })",
        "  res.json(user)",
        "})",
        "",
        'app.get("/users", async (req, res) => {',
        "  res.json(await prisma.user.findMany())",
        "})",
        "",
      ].join("\n"),
    )
  })

  it("puts each route's effect on the route that performs it", async () => {
    const result = await scanWorkspace()
    const read = symbolById(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolById(result, "ts:src/app.ts#app__post__$users__d0")

    expect(write.extKind).toBe("framework:express:route")
    expect(read.effects.map((e) => e.id)).toEqual(["db.read"])
    expect(write.effects.map((e) => e.id)).toEqual(["db.write"])
  })

  it("gives the two routes different logic fingerprints", async () => {
    const result = await scanWorkspace()
    const read = symbolById(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolById(result, "ts:src/app.ts#app__post__$users__d0")

    expect(read.fingerprint.logic).not.toBe(write.fingerprint.logic)
  })

  it("leaves the effect on the registration rather than moving it", async () => {
    const result = await scanWorkspace()

    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})
