import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { beforeEach, describe, expect, it } from "vitest"
import { scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A name a destructuring parameter binds is a parameter, so a call to it is local
 * (call-resolution.md §4.2, CR9) — the same as `function plain(save) { save() }`. Reading
 * the parameter by its pattern text (`{ save }`) left `save` out of the shadow set, and the
 * call went on to the imported `save` and took its database write.
 */

const workspace = useScratchWorkspace("destructured-parameter-shadow")

// The budget is raised so the control's write never depends on how fast the first
// classification runs on the machine.
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
  "arrow",
  "Handler.handle",
]

describe("scan — a destructuring parameter shadows the import it names", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/repo.ts",
      [
        'import { PrismaClient } from "@prisma/client"',
        "const prisma = new PrismaClient()",
        "",
        "export async function save(total: number) {",
        "  await prisma.invoice.create({ data: { total } })",
        "}",
        "",
      ].join("\n"),
    )
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
