import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { trpcFrameworkPlugin } from "@aburi/framework-trpc"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("trpc-procedure")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [trpcFrameworkPlugin],
    effects: [prismaEffectsPlugin],
  })

describe("scan — tRPC procedures whose resolvers reach a database", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/server/user.ts",
      [
        'import { initTRPC } from "@trpc/server"',
        'import { PrismaClient } from "@prisma/client"',
        "",
        "const t = initTRPC.create()",
        "const prisma = new PrismaClient()",
        "",
        "export const list = t.procedure.query(() => prisma.user.findMany())",
        "",
        "export const create = t.procedure",
        "  .input(userInput)",
        "  .mutation(({ input }) => prisma.user.create({ data: input }))",
        "",
      ].join("\n"),
    )
  })

  it("puts each resolver's effect on the procedure that runs it", async () => {
    const result = await scanWorkspace()
    const list = symbolNamed(result, "list")
    const create = symbolNamed(result, "create")

    expect([list.extKind, create.extKind]).toEqual([
      "framework:trpc:procedure",
      "framework:trpc:procedure",
    ])
    expect(list.effects.map((e) => e.id)).toEqual(["db.read"])
    expect(create.effects.map((e) => e.id)).toEqual(["db.write"])
  })
})
