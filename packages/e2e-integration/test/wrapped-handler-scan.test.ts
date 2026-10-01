import { prismaEffectsPlugin } from "@aburi/effects-prisma"
import { reactFrameworkPlugin } from "@aburi/framework-react"
import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { describe, expect, it } from "vitest"
import { diffIRs, scanWith, symbolById } from "../src/scan-helper"
import { useScratchWorkspace } from "../src/scratch"

/**
 * A handler behind an auth wrapper — `export const POST = withAuth(async (id) => …)` — is the
 * usual shape of a route, and the const it is written in had nothing from it: no rules, no
 * calls, no effects, and no other Symbol held the code either. An edit to it reached no `logic`
 * fingerprint, so `--fail-on logic-changed` passed it. This runs the real pipeline.
 */

const workspace = useScratchWorkspace("wrapped-handler")

const lineup = {
  languages: [langTypescriptPlugin],
  frameworks: [reactFrameworkPlugin],
  effects: [prismaEffectsPlugin],
}

const users = (body: string[]) =>
  [
    'import { PrismaClient } from "@prisma/client"',
    'import { withAuth } from "./auth"',
    "",
    "const prisma = new PrismaClient()",
    "",
    "export const POST = withAuth(async (id: number) => {",
    ...body.map((line) => `  ${line}`),
    "})",
    "",
  ].join("\n")

const READ = ["return prisma.user.findUnique({ where: { id } })"]
const DELETE = [
  'if (!id) throw new Error("missing id")',
  "return prisma.user.delete({ where: { id } })",
]

describe("scan — a function a const hands to a wrapping call", () => {
  it("puts the handler's rules and effects on the const", async () => {
    await workspace.writeSource("src/users.ts", users(DELETE))
    const post = symbolById(await scanWith(workspace.root, lineup), "ts:src/users.ts#POST")

    expect(post.kind).toBe("const")
    expect(post.rules.map((r) => r.type)).toEqual(["guard", "throw"])
    expect(post.effects.map((e) => [e.id, e.target])).toEqual([["db.write", "prisma.user.delete"]])
  })

  it("reports an edit to the handler as a logic change", async () => {
    await workspace.writeSource("src/users.ts", users(READ))
    const baseIR = (await scanWith(workspace.root, lineup)).ir
    await workspace.writeSource("src/users.ts", users(DELETE))
    const headIR = (await scanWith(workspace.root, lineup)).ir
    const [change] = diffIRs(baseIR, headIR).symbols

    expect(change?.status).toBe("changed")
    if (change?.status !== "changed") return
    expect(change.after.name).toBe("POST")
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
