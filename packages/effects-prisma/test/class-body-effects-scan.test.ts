import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("class-body-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

describe("scan — a class whose members write to a database", () => {
  beforeEach(async () => {
    await workspace.writeSource(
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

  it("leaves the write on the method that performs it", async () => {
    const result = await scanWorkspace()
    const create = symbolById(result, "ts:src/user.service.ts#UserService.create")

    expect(create.effects.map((e) => e.id)).toContain("db.write")
  })

  it("does not repeat the write on the class that declares the method", async () => {
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

  it("resolves the instantiation to the class, and nothing to the constructor", async () => {
    const result = await scanWorkspace()
    const resolved = result.ir.symbols.flatMap((symbol) => symbol.calls.map((c) => c.resolved))

    expect(resolved).toContain("ts:src/user.service.ts#UserService")
    expect(resolved).not.toContain("ts:src/user.service.ts#UserService.constructor")
  })
})

describe("scan — a member beside a namespace export of the same name", () => {
  it("keeps the member's write on the member, apart from the dropped export", async () => {
    await workspace.writeSource(
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
    const owner = symbolById(result, "ts:src/merged.ts#C")
    const member = symbolById(result, "ts:src/merged.ts#C.m")
    const exported = symbolById(result, "ts:src/merged.ts#C::m")

    expect([member.kind, member.dropped]).toEqual(["method", false])
    expect(member.effects.map((e) => e.id)).toEqual(["db.write"])
    expect([exported.kind, exported.dropped]).toEqual(["type", true])
    expect(owner.calls).toEqual([])
    // The class once re-walked the member and reported the write on `#C` as well.
    expect(result.ir.symbols.flatMap((s) => s.effects.map((e) => e.id))).toEqual(["db.write"])
  })
})

describe("scan — a class whose constructor writes to a database", () => {
  it("keeps the write on the class, so instantiating it says so", async () => {
    await workspace.writeSource(
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
    await workspace.writeSource(
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

    expect(symbolById(result, "ts:src/seeder.ts#Seeder").effects.map((e) => e.id)).toContain(
      "db.write",
    )
    expect(symbolById(result, "ts:src/boot.ts#boot").effects.map((e) => e.id)).toContain("db.write")
  })
})
