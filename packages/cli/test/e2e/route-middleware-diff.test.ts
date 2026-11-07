import { readFile } from "node:fs/promises"
import { commitAll, gitTestEnv, initRepository, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_OUTPUT_DIRNAME, EXIT } from "../../src"
import { defaultOutput } from "../workspace"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"

const workspace = useScratchWorkspace("route-middleware")

const routes = (...middleware: string[]) =>
  [
    'import { Router } from "express"',
    'import { requireAdmin } from "./middleware"',
    "export const router = Router()",
    `router.get("/users", ${[...middleware, "async (_req, res) => {"].join(", ")}`,
    "  res.json([])",
    "})",
    "",
  ].join("\n")

useBuiltBin()

beforeEach(async () => {
  await workspace.writeSource("package.json", '{"name":"api","private":true}\n')
  await workspace.writeSource(
    "aburi.json",
    '{"languages":["lang-typescript"],"frameworks":["framework-express"]}\n',
  )
  await workspace.writeSource(".gitignore", `${DEFAULT_OUTPUT_DIRNAME}/\n`)
  await workspace.writeSource("src/routes.ts", routes("requireAdmin"))
  await initRepository(workspace.root)
  await commitAll(workspace.root, "c1")
  await workspace.writeSource("src/routes.ts", routes())
  await commitAll(workspace.root, "c2")
  return () => removeWorktreeTempDirs(workspace.root)
})

describe("aburi diff — a route that loses its middleware", () => {
  it("reports a logic change naming the middleware, which a logic gate stops", async () => {
    const run = await runBin(
      workspace.root,
      ["diff", "HEAD~1..HEAD", "--fail-on", "logic-changed"],
      gitTestEnv(workspace.root),
    )
    expect(run.code, run.stderr).toBe(EXIT.GATE)

    const report = await readFile(defaultOutput(workspace.root, "diff.md"), "utf8")
    expect(report).toContain("- middleware removed: `requireAdmin`")
    expect(report).not.toContain("Syntax-only changes")
  })
})
