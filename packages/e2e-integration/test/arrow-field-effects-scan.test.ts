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
 * The same report as the class-body one, on the other common way to write a service: a
 * method written as a field holding an arrow. Constructing the class creates the closure and
 * does not run it, so a factory that only instantiates the service writes nothing.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-arrow-field-effects-"))
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

describe("scan — a service whose members are fields holding arrows", () => {
  beforeEach(async () => {
    await writeSource(
      "src/user.service.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class UserService {",
        "  constructor(private readonly prisma: PrismaClient) {}",
        "",
        "  create = async (data: unknown) => {",
        "    return this.prisma.user.create({ data })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    await writeSource(
      "src/factory.ts",
      [
        'import { UserService } from "./user.service"',
        "",
        "export function makeService(prisma: any) {",
        "  return new UserService(prisma)",
        "}",
        "",
      ].join("\n"),
    )
  })

  it("puts the write on the member the field declares", async () => {
    const result = await scanWorkspace()
    const create = symbolNamed(result, "ts:src/user.service.ts#UserService.create")

    expect(create.kind).toBe("method")
    expect(create.effects.map((e) => e.id)).toContain("db.write")
  })

  it("leaves the class with nothing constructing it does not run", async () => {
    const result = await scanWorkspace()
    const service = symbolNamed(result, "ts:src/user.service.ts#UserService")

    expect(service.effects).toEqual([])
    expect(service.calls).toEqual([])
  })

  it("does not propagate it into a factory that only constructs the class", async () => {
    const result = await scanWorkspace()
    const factory = symbolNamed(result, "ts:src/factory.ts#makeService")

    expect(factory.effects).toEqual([])
    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})

describe("scan — a field initialiser that does run at construction", () => {
  it("keeps the write on the class, so instantiating it says so", async () => {
    // The distinction the change rests on, written twice in one class: `seeded = …create(…)`
    // runs when the class is constructed, and `reset = () => …` does not.
    await writeSource(
      "src/seeder.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class Seeder {",
        "  private client = new PrismaClient()",
        "  seeded = this.client.user.create({ data: {} })",
        "  reset = () => {}",
        "}",
        "",
      ].join("\n"),
    )
    await writeSource(
      "src/boot.ts",
      [
        'import { Seeder } from "./seeder"',
        "",
        "export function boot() {",
        "  return new Seeder()",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "ts:src/seeder.ts#Seeder").effects.map((e) => e.id)).toContain(
      "db.write",
    )
    expect(symbolNamed(result, "ts:src/boot.ts#boot").effects.map((e) => e.id)).toContain(
      "db.write",
    )
  })
})
