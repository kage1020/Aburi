import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { diffOfEditWith, scanWith } from "@aburi/test-harness"
import { symbolById, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"

const workspace = useScratchWorkspace("wrapped-handler")

const lineup = {
  languages: [langTypescriptPlugin],
  frameworks: [reactFrameworkPlugin],
  effects: [prismaEffectsPlugin],
}

const users = (head: string, body: string[]) =>
  [
    'import { PrismaClient } from "@prisma/client"',
    'import { withAuth } from "./auth"',
    "",
    "const prisma = new PrismaClient()",
    "",
    `${head} withAuth(async (id: number) => {`,
    ...body.map((line) => `  ${line}`),
    "})",
    "",
  ].join("\n")

const READ = ["return prisma.user.findUnique({ where: { id } })"]
const DELETE = [
  'if (!id) throw new Error("missing id")',
  "return prisma.user.delete({ where: { id } })",
]

const SPELLINGS = [
  ["a const", "export const POST =", "POST"],
  ["a default export", "export default", "<default>"],
] as const

describe("scan — a function a const or a default export hands to a wrapping call", () => {
  it.each(SPELLINGS)("puts the handler's rules and effects on %s", async (_label, head, name) => {
    await workspace.writeSource("src/users.ts", users(head, DELETE))
    const result = await scanWith(workspace.root, lineup)
    const handler = symbolById(result, `ts:src/users.ts#${name}`)

    expect(handler.kind).toBe("const")
    expect(handler.rules.map((r) => r.type)).toEqual(["guard", "throw"])
    expect(handler.effects.map((e) => [e.id, e.target])).toEqual([
      ["db.write", "prisma.user.delete"],
    ])
  })

  it.each(
    SPELLINGS,
  )("reports an edit to the handler in %s as a logic change", async (_label, head, name) => {
    const { diff } = await diffOfEditWith(
      workspace,
      lineup,
      "src/users.ts",
      users(head, READ),
      users(head, DELETE),
    )

    expect(diff.symbols).toHaveLength(1)
    const [change] = diff.symbols
    expect(change?.status).toBe("changed")
    if (change?.status !== "changed") return
    expect(change.after.name).toBe(name)
    expect(change.delta.logicChanged).toBe(true)
  })

  it("keeps a wrapped React component classified, and gives it its body", async () => {
    await workspace.writeSource(
      "src/Row.tsx",
      [
        'import { memo, forwardRef } from "react"',
        "export const Row = memo(function Row({ id }: { id: string }) {",
        '  if (!id) throw new Error("id")',
        "  track(id)",
        "  return <li>{id}</li>",
        "})",
        "export const Input = forwardRef((props: any, ref: any) => {",
        "  useFocus(ref)",
        "  return <input ref={ref} />",
        "})",
        "",
      ].join("\n"),
    )
    const result = await scanWith(workspace.root, lineup)
    const row = symbolById(result, "ts:src/Row.tsx#Row")
    const input = symbolById(result, "ts:src/Row.tsx#Input")

    expect(row.extKind).toBe("framework:react:memo")
    expect(row.rules.map((r) => r.type)).toEqual(["guard", "throw", "return"])
    expect(row.calls.map((c) => c.target)).toEqual(["Error", "track"])
    expect(input.extKind).toBe("framework:react:forward-ref")
    expect(input.calls.map((c) => c.target)).toEqual(["useFocus"])
  })
})
