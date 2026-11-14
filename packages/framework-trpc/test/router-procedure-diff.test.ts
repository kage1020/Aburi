import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith } from "@aburi/test-harness"
import { soleChange, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { trpcFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("router-procedure")

const lineup = { languages: [langTypescriptPlugin], frameworks: [trpcFrameworkPlugin] }

const router = (...resolver: string[]) =>
  [
    'import { initTRPC, TRPCError } from "@trpc/server"',
    "const t = initTRPC.create()",
    "export const postRouter = t.router({",
    "  byId: t.procedure.query(({ ctx, input }) => {",
    ...resolver.map((line) => `    ${line}`),
    "    return ctx.db.post.findUnique({ where: { id: input } })",
    "  }),",
    "})",
    "",
  ].join("\n")

describe("diff — a procedure written inside a router", () => {
  it("reports an edit to its resolver as a logic change to the router", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/server.ts",
      router(),
      router('if (!input) throw new TRPCError({ code: "BAD_REQUEST" })'),
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const change = soleChange(diff.symbols, "changed")
    expect(change.after.id).toBe("ts:src/server.ts#postRouter")
    expect(change.delta.logicChanged).toBe(true)
  })
})
