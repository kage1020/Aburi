import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("class-member-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] })

const FACTORY = [
  'import { UserService } from "./user.service"',
  "",
  "export function makeService(prisma: any) {",
  "  return new UserService(prisma)",
  "}",
  "",
].join("\n")

function userService(member: string[]): string {
  return [
    'import { PrismaClient } from "@prisma/client"',
    "",
    "export class UserService {",
    "  constructor(private readonly prisma: PrismaClient) {}",
    "",
    ...member.map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n")
}

describe.each([
  [
    "a method",
    ["async create(data: unknown) {", "  return this.prisma.user.create({ data })", "}"],
  ],
  [
    "a field holding an arrow",
    ["create = async (data: unknown) => {", "  return this.prisma.user.create({ data })", "}"],
  ],
])("scan — a class whose member writes to a database through %s", (_form, member) => {
  it("puts the write on the member, and nothing on the class that declares it", async () => {
    await workspace.writeSource("src/user.service.ts", userService(member))

    const result = await scanWorkspace()
    const create = symbolById(result, "ts:src/user.service.ts#UserService.create")
    const service = symbolById(result, "ts:src/user.service.ts#UserService")

    expect(create.kind).toBe("method")
    expect(create.effects.map((e) => e.id)).toEqual(["db.write"])
    expect(service.effects).toEqual([])
    expect(service.calls).toEqual([])
  })

  it("does not propagate the write into a factory that only constructs the class", async () => {
    await workspace.writeSource("src/user.service.ts", userService(member))
    await workspace.writeSource("src/factory.ts", FACTORY)

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:src/factory.ts#makeService").effects).toEqual([])
    expect(result.ir.stats.effectPropagation.symbolsWithPropagatedEffects).toBe(0)
  })
})

describe("scan — constructing a class", () => {
  it("resolves the instantiation to the class, and nothing to the constructor", async () => {
    await workspace.writeSource(
      "src/user.service.ts",
      userService([
        "async create(data: unknown) {",
        "  return this.prisma.user.create({ data })",
        "}",
      ]),
    )
    await workspace.writeSource("src/factory.ts", FACTORY)

    const result = await scanWorkspace()
    const resolved = result.ir.symbols.flatMap((symbol) => symbol.calls.map((c) => c.resolved))

    expect(resolved).toContain("ts:src/user.service.ts#UserService")
    expect(resolved).not.toContain("ts:src/user.service.ts#UserService.constructor")
  })

  it.each([
    [
      "its constructor",
      ["constructor(prisma: PrismaClient) {", "  prisma.user.create({ data: {} })", "}"],
    ],
    [
      "a field initialiser",
      ["private client = new PrismaClient()", "seeded = this.client.user.create({ data: {} })"],
    ],
  ])("keeps a write run by %s on the class, so instantiating it says so", async (_form, body) => {
    await workspace.writeSource(
      "src/seeder.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "",
        "export class Seeder {",
        ...body.map((line) => `  ${line}`),
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
        "export function boot(prisma: any) {",
        "  return new Seeder(prisma)",
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolById(result, "ts:src/seeder.ts#Seeder").effects.map((e) => e.id)).toEqual([
      "db.write",
    ])
    expect(symbolById(result, "ts:src/boot.ts#boot").effects).toMatchObject([
      { id: "db.write", propagated: true, derivedFrom: ["ts:src/seeder.ts#Seeder"] },
    ])
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
    expect(result.ir.symbols.flatMap((s) => s.effects.map((e) => e.id))).toEqual(["db.write"])
  })
})
