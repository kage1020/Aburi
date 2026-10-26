import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { prismaEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("module-scope-effects")

const SEED = [
  'import { PrismaClient } from "@prisma/client"',
  "const prisma = new PrismaClient()",
  "",
  "export async function seed() {",
  "  await prisma.user.create({ data: {} })",
  "}",
  "",
  "await prisma.user.deleteMany({})",
  "await seed()",
  "",
].join("\n")

describe("scan — a write a module makes when it is imported", () => {
  it("is the module scope's, made there or by a function it calls, and no importer's", async () => {
    await workspace.writeSource("src/seed.ts", SEED)
    await workspace.writeSource(
      "src/app.ts",
      'import "./seed"\nimport { seed } from "./seed"\nexport function start() { listen() }\n',
    )

    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      effects: [prismaEffectsPlugin],
    })

    expect(symbolById(result, "ts:src/seed.ts#<module>").effects).toMatchObject([
      { id: "db.write", target: "prisma.user.deleteMany", line: 8 },
      {
        id: "db.write",
        target: "prisma.user.create",
        propagated: true,
        derivedFrom: ["ts:src/seed.ts#seed"],
      },
    ])
    expect(symbolById(result, "ts:src/app.ts#start").effects).toEqual([])
    expect(result.ir.symbols.map((s) => s.id)).not.toContain("ts:src/app.ts#<module>")
  })
})
