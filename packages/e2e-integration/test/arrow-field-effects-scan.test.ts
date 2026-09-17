import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The same report as the class-body one, on the other common way to write a service: a
 * method written as a field holding an arrow. Constructing the class creates the closure and
 * does not run it, so a factory that only instantiates the service writes nothing.
 */

const workspace = useScratchWorkspace("arrow-field-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

describe("scan — a service whose members are fields holding arrows", () => {
  beforeEach(async () => {
    await workspace.writeSource(
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
    await workspace.writeSource(
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
    const create = symbolById(result, "ts:src/user.service.ts#UserService.create")

    expect(create.kind).toBe("method")
    expect(create.effects.map((e) => e.id)).toContain("db.write")
  })

  it("leaves the class with nothing constructing it does not run", async () => {
    const result = await scanWorkspace()
    const service = symbolById(result, "ts:src/user.service.ts#UserService")

    expect(service.effects).toEqual([])
    expect(service.calls).toEqual([])
  })

  it("does not propagate it into a factory that only constructs the class", async () => {
    const result = await scanWorkspace()
    const factory = symbolById(result, "ts:src/factory.ts#makeService")

    expect(factory.effects).toEqual([])
    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})

describe("scan — a field initialiser that does run at construction", () => {
  it("keeps the write on the class, so instantiating it says so", async () => {
    // Both halves of the distinction in one class: `seeded = …create(…)` runs when the class
    // is constructed, and `reset = () => …` does not.
    await workspace.writeSource(
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
    await workspace.writeSource(
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

    expect(symbolById(result, "ts:src/seeder.ts#Seeder").effects.map((e) => e.id)).toContain(
      "db.write",
    )
    expect(symbolById(result, "ts:src/boot.ts#boot").effects.map((e) => e.id)).toContain("db.write")
  })
})
