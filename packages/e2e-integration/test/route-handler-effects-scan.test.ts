import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * An Express app whose every route writes to the database reported no effects at all,
 * because the route Symbol had no body and the handler had no Symbol.
 */

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
    // The axis is rules plus effects, so while a route had no body every route in a file
    // hashed identically — a reader diffing two revisions could not see one route's handler
    // start writing where another only read.
    const result = await scanWorkspace()
    const read = symbolById(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolById(result, "ts:src/app.ts#app__post__$users__d0")

    expect(read.fingerprint.logic).not.toBe(write.fingerprint.logic)
  })

  it("leaves the effect on the registration rather than moving it", async () => {
    // Nothing resolves a call to a route Symbol, so an effect found in a handler sits where
    // the handler is registered instead of propagating to a caller.
    const result = await scanWorkspace()

    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})
