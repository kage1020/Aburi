import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith } from "@aburi/test-harness"
import { soleChange, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SymbolChanged } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { trpcFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("procedure-middleware")

const SOURCE = "src/server.ts"

const lineup = { languages: [langTypescriptPlugin], frameworks: [trpcFrameworkPlugin] }

const server = (declaration: string) =>
  [
    'import { initTRPC } from "@trpc/server"',
    'import { audit, isAuthed } from "./middleware"',
    "const t = initTRPC.create()",
    declaration,
    "",
  ].join("\n")

const byId = (...steps: string[]) =>
  server(
    `export const byId = ${["t.procedure", ...steps, "query(({ input }) => find(input))"].join(".")}`,
  )

function onlyChange(diff: DiffResult): SymbolChanged {
  expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
  return soleChange(diff.symbols, "changed")
}

describe("diff — a procedure's middleware", () => {
  it.each([
    ["removed", ["use(isAuthed)"], [], { added: [], removed: ["isAuthed"], reordered: false }],
    ["added", [], ["use(isAuthed)"], { added: ["isAuthed"], removed: [], reordered: false }],
    [
      "reordered",
      ["use(isAuthed)", "use(audit)"],
      ["use(audit)", "use(isAuthed)"],
      { added: [], removed: [], reordered: true },
    ],
  ])("is a logic change when one is %s", async (_edit, before, after, middleware) => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      byId(...before),
      byId(...after),
    )

    const change = onlyChange(diff)
    expect(change.after.id).toBe("ts:src/server.ts#byId")
    expect(change.delta).toMatchObject({ logicChanged: true, middleware })
  })

  it("is no change when the middleware is only rewrapped and commented", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      byId("use(isAuthed)", "use(audit)"),
      server(
        [
          "export const byId = t.procedure",
          "  .use(isAuthed) // the gate",
          "  .use(",
          "    audit,",
          "  )",
          "  .query(({ input }) => find(input))",
        ].join("\n"),
      ),
    )

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0 })
  })

  it("is a logic change to the base procedure that loses a use", async () => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      SOURCE,
      server("export const protectedProcedure = t.procedure.use(audit).use(isAuthed)"),
      server("export const protectedProcedure = t.procedure.use(audit)"),
    )

    expect(onlyChange(diff).delta).toMatchObject({
      logicChanged: true,
      middleware: { added: [], removed: ["isAuthed"], reordered: false },
    })
  })
})
