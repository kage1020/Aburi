import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type ScanResult, scan } from "@aburi/core"
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { VocabRegistry } from "@aburi/plugin-registry"
import type { Symbol as IRSymbol } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * A delegate reached through brackets — `prisma["user"].create(…)`, `prisma[model].create(…)`.
 * The walk used to answer the object alone, so both arrived as `prisma.create`: a call written
 * nowhere in the source, one segment short of the delegate shape `effects-prisma` matches, and
 * so a write that never reached the report at all.
 *
 * Both spellings write to the database and both say so here. What separates them is what the
 * source knows: a literal index is the model, and a computed one is not a name, which the
 * confidence tier carries rather than the effect's presence.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-bracket-delegate-"))
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
  registry.register(prismaEffectsPlugin.manifest)
  return scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [langTypescriptPlugin],
    frameworks: [],
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

describe("scan — a Prisma delegate addressed through brackets", () => {
  beforeEach(async () => {
    await writeSource(
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
    const create = symbolNamed(result, "ts:src/repo.ts#createUser")

    expect(
      create.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.write", target: "prisma.user.create", confidence: "high" }])
  })

  it("keeps the write on a computed index, and says the model is not a name", async () => {
    const result = await scanWorkspace()
    const create = symbolNamed(result, "ts:src/repo.ts#createAny")

    expect(
      create.effects.map((e) => ({ id: e.id, target: e.target, confidence: e.confidence })),
    ).toEqual([{ id: "db.write", target: "prisma.<computed>.create", confidence: "medium" }])
  })
})
