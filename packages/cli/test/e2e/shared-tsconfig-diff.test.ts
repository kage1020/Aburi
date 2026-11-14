import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  commitAll,
  gitTestEnv,
  initRepository,
  linkDirectory,
  useScratchWorkspace,
} from "@aburi/test-support"
import type { DiffResult } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import { defaultOutput } from "../workspace"
import { removeWorktreeTempDirs, runBin, useBuiltBin } from "./bin"

const workspace = useScratchWorkspace("shared-tsconfig")

useBuiltBin()

// The path alias lives in a workspace package's config, which only an install links into
// `node_modules`; the base revision is checked out without one.
beforeEach(async () => {
  const files: Record<string, string> = {
    "package.json": '{"name":"api","private":true}\n',
    ".gitignore": "node_modules/\n",
    "aburi.json": '{"languages":["lang-typescript"],"frameworks":["framework-nestjs"]}\n',
    "packages/tsconfig/package.json": '{"name":"@repo/tsconfig"}\n',
    "packages/tsconfig/base.json": JSON.stringify({
      compilerOptions: { paths: { "@app/*": [`\${configDir}/libs/*/src`] } },
    }),
    "tsconfig.json": '{"extends":"@repo/tsconfig/base.json"}\n',
    "libs/common/src/index.ts": 'export { Controller, Get } from "@nestjs/common"\n',
    "src/users.controller.ts": [
      'import { Controller, Get } from "@app/common"',
      '@Controller("users")',
      "export class UsersController {",
      "  @Get() list() { return [] }",
      "}",
      "",
    ].join("\n"),
  }
  for (const [path, content] of Object.entries(files)) await workspace.writeSource(path, content)
  await initRepository(workspace.root)
  await commitAll(workspace.root, "c1")
  await workspace.writeSource("src/other.ts", "export function other(): number { return 1 }\n")
  await commitAll(workspace.root, "c2")
  await mkdir(join(workspace.root, "node_modules/@repo"), { recursive: true })
  await linkDirectory(
    join(workspace.root, "packages/tsconfig"),
    join(workspace.root, "node_modules/@repo/tsconfig"),
  )
  return () => removeWorktreeTempDirs(workspace.root)
})

describe("aburi diff <base>..<head> — a path alias from a workspace package's config", () => {
  it("grades a decorator imported through it alike on both sides", async () => {
    const run = await runBin(workspace.root, ["diff", "HEAD~1..HEAD"], gitTestEnv(workspace.root))
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).not.toContain("no config file was found")

    const diff = JSON.parse(
      await readFile(defaultOutput(workspace.root, "diff.json"), "utf8"),
    ) as DiffResult
    expect(diff.symbols).toEqual([
      {
        status: "added",
        symbol: expect.objectContaining({ id: "ts:src/other.ts#other" }),
      },
    ])
  })
})
