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
 * The consequence the report is actually about, reached the way it reaches a user: a factory
 * that only constructs a service was told it writes to the database.
 *
 * The class Symbol's body is the whole `class_body`, so the walk recorded every method's calls
 * on the class as well as on the method. `new UserService()` resolves to the class Symbol
 * (`call-resolution.md` CR15), so effect propagation carried those duplicates up into every
 * caller that instantiates it — through a function whose own body touches nothing.
 */

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-class-body-effects-"))
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

describe("scan — a class whose members write to a database", () => {
  beforeEach(async () => {
    await writeSource(
      "src/user.service.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class UserService {",
        "  constructor(private readonly prisma: PrismaClient) {}",
        "",
        "  async create(data: unknown) {",
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

  it("leaves the write on the method that performs it", async () => {
    const result = await scanWorkspace()
    const create = symbolNamed(result, "ts:src/user.service.ts#UserService.create")

    expect(create.effects.map((e) => e.id)).toContain("db.write")
  })

  it("does not repeat the write on the class that declares the method", async () => {
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

  it("resolves the instantiation to the class, and nothing to the constructor", async () => {
    // The two halves of why the constructor's body still counts on the class: `new` resolves
    // to the class Symbol, and nothing resolves to `#UserService.constructor` — so recording
    // a constructor body on both propagates it nowhere twice.
    const result = await scanWorkspace()
    const resolved = result.ir.symbols.flatMap((s) => s.calls.map((c) => c.resolved))

    expect(resolved).toContain("ts:src/user.service.ts#UserService")
    expect(resolved).not.toContain("ts:src/user.service.ts#UserService.constructor")
  })
})

describe("scan — a member whose Symbol was folded into a droppable one", () => {
  it("records the member's calls nowhere, because the Symbol that owns them is dropped", async () => {
    // `namespace C { export type m }` and `class C { m() {} }` are two entities the qualified-name
    // convention spells `#C.m` both ways, so they fold — and the type alias is written first, so
    // the folded Symbol is a `type` and the drop list removes it before anything walks it.
    //
    // The fold is a known defect of the qualified-name convention, and this change does not touch it. What it does change is the symptom: the
    // class used to re-walk the member, so `write` was reported on `#C` as well. It is not any
    // more, which is right on its own terms — a dropped Symbol is one the pipeline was asked not
    // to analyse, and having its calls reappear on the enclosing class was leakage — but on this
    // input it turns a duplicate into an omission. Pinned so the fold's fix has something to move.
    await writeSource(
      "src/merged.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export namespace C {",
        "  export type m = string",
        "}",
        "export class C {",
        "  m(prisma: PrismaClient) { prisma.user.create({ data: {} }) }",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const owner = symbolNamed(result, "ts:src/merged.ts#C")
    const member = symbolNamed(result, "ts:src/merged.ts#C.m")

    expect(member.kind).toBe("type")
    expect(member.dropped).toBe(true)
    expect(owner.calls).toEqual([])
    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
  })
})

describe("scan — a class whose constructor writes to a database", () => {
  it("keeps the write on the class, so instantiating it says so", async () => {
    // `new Seeder()` runs the constructor, and CR15 resolves it to the class Symbol. A class
    // body that dropped its constructor would make this write invisible to every caller.
    await writeSource(
      "src/seeder.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class Seeder {",
        "  constructor(prisma: PrismaClient) {",
        "    prisma.user.create({ data: {} })",
        "  }",
        "}",
        "",
      ].join("\n"),
    )
    await writeSource(
      "src/boot.ts",
      [
        'import { Seeder } from "./seeder"',
        "",
        "export function boot(prisma: any) {",
        "  return new Seeder(prisma)",
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
