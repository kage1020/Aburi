import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { irSchemaViolations, symbolById, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("destructured-parameter-shadow")

const scanWorkspace = () =>
  scanWith(
    workspace.root,
    { languages: [langTypescriptPlugin], effects: [prismaEffectsPlugin] },
    { classifyTimeoutMs: 5000 },
  )

const SHADOWED = [
  "plain",
  "withDeps",
  "withTuple",
  "renamed",
  "defaulted",
  "nested",
  "rest",
  "restName",
  "arrow",
  "Handler.handle",
]

const REPO = [
  'import { PrismaClient } from "@prisma/client"',
  "const prisma = new PrismaClient()",
  "",
  "export async function save(total: number) {",
  "  await prisma.invoice.create({ data: { total } })",
  "}",
  "",
].join("\n")

describe("scan — a destructuring parameter shadows the import it names", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/repo.ts", REPO)
    await workspace.writeSource(
      "src/handler.ts",
      [
        'import { save } from "./repo"',
        "",
        "type Deps = { save: (total: number) => Promise<void> }",
        "",
        'export async function plain(save: Deps["save"]) { await save(1) }',
        "export async function withDeps({ save }: Deps) { await save(2) }",
        'export async function withTuple([save]: [Deps["save"]]) { await save(3) }',
        'export async function renamed({ persist: save }: { persist: Deps["save"] }) { await save(4) }',
        "export async function defaulted({ save = async (n: number) => {} }: Partial<Deps> = {}) { await save(5) }",
        "export async function nested({ deps: { save } }: { deps: Deps }) { await save(6) }",
        'export async function rest(...[save]: [Deps["save"]]) { await save(7) }',
        "export async function restName(...save: any) { await save(11) }",
        "export const arrow = async ({ save }: Deps) => { await save(8) }",
        "export class Handler { async handle({ save }: any) { await save(9) } }",
        "export async function direct() { await save(10) }",
        "",
      ].join("\n"),
    )
  })

  it.each(SHADOWED)("%s leaves `save` unresolved and takes no effect", async (qname) => {
    const result = await scanWorkspace()
    const symbol = symbolById(result, `ts:src/handler.ts#${qname}`)

    expect(symbol.calls.map((c) => [c.target, c.resolved])).toEqual([["save", null]])
    expect(symbol.effects).toEqual([])
  })

  it("still links a call that names the import, and carries its write", async () => {
    const result = await scanWorkspace()
    const direct = symbolById(result, "ts:src/handler.ts#direct")

    expect(direct.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["save", "ts:src/repo.ts#save"],
    ])
    expect(direct.effects.map((e) => e.id)).toEqual(["db.write"])
  })
})

describe("scan — a destructuring parameter with text the parser could not place", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/repo.ts", REPO)
    await workspace.writeSource(
      "src/broken.ts",
      [
        'import { save } from "./repo"',
        "",
        "export async function stray({ save, ? }: any) { await save(1) }",
        "export async function dangling({ save = }: any) { await save(2) }",
        "export async function unseparated({ save b }: any) { await save(3) }",
        "export async function arraySpread([...]: any) { await save(4) }",
        "export async function objectSpread({ ... }: any) { await save(5) }",
        "export async function strayFirst({ a, ?, save }: any) { await save(6) }",
        "export async function arrayStray([a, ?, save]: any) { await save(7) }",
        "export async function arrayStrayLast([save, ?]: any) { await save(8) }",
        "export async function arrayUnseparated([a, save b]: any) { await save(9) }",
        "export async function placed({ a: obj.b, save }: any) { await save(10) }",
        "export async function placedOnly({ save: obj.b }: any) { await save(11) }",
        "",
      ].join("\n"),
    )
  })

  it("keeps the file, and the document still validates", async () => {
    const result = await scanWorkspace()

    expect(result.skipped).toEqual([])
    expect(irSchemaViolations(result.ir)).toEqual([])
  })

  it.each([
    ["stray", "{ save, ? }", ["save"], null],
    ["dangling", "{ save = }", ["save"], null],
    ["unseparated", "{ save b }", ["save"], null],
    ["arraySpread", "[...]", undefined, "ts:src/repo.ts#save"],
    ["objectSpread", "{ ... }", undefined, "ts:src/repo.ts#save"],
    ["strayFirst", "{ a, ?, save }", ["a", "save"], null],
    ["arrayStray", "[a, ?, save]", ["a", "save"], null],
    ["arrayStrayLast", "[save, ?]", ["save"], null],
    ["arrayUnseparated", "[a, save b]", ["a", "save"], null],
    ["placed", "{ a: obj.b, save }", ["save"], null],
    ["placedOnly", "{ save: obj.b }", undefined, "ts:src/repo.ts#save"],
  ])("%s binds only what the source placed", async (qname, name, bindings, resolved) => {
    const result = await scanWorkspace()
    const symbol = symbolById(result, `ts:src/broken.ts#${qname}`)

    expect(symbol.signature?.inputs).toStrictEqual([
      bindings === undefined ? { name, type: "any" } : { name, type: "any", bindings },
    ])
    expect(symbol.calls.map((c) => [c.target, c.resolved])).toEqual([["save", resolved]])
  })
})

describe("scan — a function a const hands its call is not shadowed", () => {
  beforeEach(async () => {
    await workspace.writeSource("src/repo.ts", REPO)
    await workspace.writeSource(
      "src/route.ts",
      [
        'import { save } from "./repo"',
        'import { withAuth } from "./auth"',
        "",
        "export const POST = withAuth(async ({ save }: any) => { await save(1) })",
        "export const PUT = withAuth(async (save: any) => { await save(2) })",
        "",
      ].join("\n"),
    )
  })

  it.each(["POST", "PUT"])("%s links `save` to the import", async (qname) => {
    const result = await scanWorkspace()
    const symbol = symbolById(result, `ts:src/route.ts#${qname}`)

    expect(symbol.signature).toBeNull()
    expect(symbol.calls.map((c) => [c.target, c.resolved])).toEqual([
      ["save", "ts:src/repo.ts#save"],
    ])
    expect(symbol.effects.map((e) => e.id)).toEqual(["db.write"])
  })
})
