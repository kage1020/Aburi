import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { expressFrameworkPlugin } from "@aburi/framework-express"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { Symbol as IRSymbol } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * The consequence reached the way it reaches a user: an Express app whose every route writes
 * to the database reported no effects at all, because the route Symbol had no body and the
 * handler had no Symbol.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-route-handler-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function writeSource(rel: string, content: string): Promise<void> {
  const abs = join(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

async function scanWorkspace(): Promise<ScanResult> {
  const registry = new VocabRegistry()
  registry.register(langTypescriptPlugin.manifest)
  registry.register(expressFrameworkPlugin.manifest)
  registry.register(prismaEffectsPlugin.manifest)
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [expressFrameworkPlugin],
    effects: [prismaEffectsPlugin],
    registry,
    components: [],
  })
}

function symbolNamed(result: ScanResult, id: string): IRSymbol {
  const found = result.ir.symbols.find((s) => s.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${result.ir.symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

describe("scan — an Express route whose handler writes to a database", () => {
  beforeEach(async () => {
    await writeSource(
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

  it("puts the write on the route that performs it", async () => {
    const result = await scanWorkspace()
    const route = symbolNamed(result, "ts:src/app.ts#app__post__$users__d0")

    expect(route.extKind).toBe("framework:express:route")
    expect(route.effects.map((e) => e.id)).toContain("db.write")
  })

  it("tells the two routes apart by what each one does", async () => {
    const result = await scanWorkspace()

    expect(
      symbolNamed(result, "ts:src/app.ts#app__get__$users__d0").effects.map((e) => e.id),
    ).toEqual(["db.read"])
    expect(
      symbolNamed(result, "ts:src/app.ts#app__post__$users__d0").effects.map((e) => e.id),
    ).toEqual(["db.write"])
  })

  it("gives the two routes different logic fingerprints", async () => {
    // The axis is rules plus effects, so while a route had no body every route in a file
    // hashed identically here — a reader diffing two revisions could not see one route's
    // handler start writing where another only read.
    const result = await scanWorkspace()
    const read = symbolNamed(result, "ts:src/app.ts#app__get__$users__d0")
    const write = symbolNamed(result, "ts:src/app.ts#app__post__$users__d0")

    expect(read.fingerprint.logic).not.toBe(write.fingerprint.logic)
  })

  it("leaves the effect on the registration rather than moving it", async () => {
    // Nothing resolves a call to a route Symbol, so an effect found in a handler sits where
    // the handler is registered instead of propagating to a caller.
    const result = await scanWorkspace()

    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})
