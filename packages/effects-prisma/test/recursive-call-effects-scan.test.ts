import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("recursive-call-effects")

const SERVICE = [
  "export namespace Service {",
  "  export function run(n: number) {",
  "    return Store.save(n)",
  "  }",
  "}",
  "",
].join("\n")

function store(callBack: string[]): string {
  return [
    'import { PrismaClient } from "@prisma/client"',
    "const prisma = new PrismaClient()",
    "",
    "export namespace Store {",
    "  export function save(n: number) {",
    ...callBack,
    "    return prisma.invoice.create({ data: { n } })",
    "  }",
    "}",
    "",
  ].join("\n")
}

describe("scan — a write reached through a namespace call the writer calls back", () => {
  it.each([
    ["without", []],
    ["with", ["    if (n > 0) Service.run(n - 1)"]],
  ])("keeps the caller's write at the call's medium, %s the call back", async (_case, callBack) => {
    await workspace.writeSource("a.ts", SERVICE)
    await workspace.writeSource("b.ts", store(callBack))

    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      effects: [prismaEffectsPlugin],
    })

    expect(symbolById(result, "ts:a.ts#Service.run").effects).toMatchObject([
      {
        id: "db.write",
        target: "prisma.invoice.create",
        confidence: "medium",
        propagated: true,
        derivedFrom: ["ts:b.ts#Store.save"],
      },
    ])
  })
})
