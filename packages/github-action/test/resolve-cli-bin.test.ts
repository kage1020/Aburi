import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runScript } from "./fixtures/scripts"

const scratch = useScratchWorkspace("resolve-cli-bin")

function runFrom(cwd: string) {
  return runScript("resolve-cli-bin.mjs", { cwd })
}

/** A project under the scratch root with an `@aburi/cli` installed as given; returns its path. */
async function installed(options: {
  manifest?: string
  bin?: unknown
  binFile?: boolean
}): Promise<string> {
  const cli = "project/node_modules/@aburi/cli"
  await scratch.writeSource(
    `${cli}/package.json`,
    options.manifest ??
      JSON.stringify({ name: "@aburi/cli", version: "0.0.0-test", bin: options.bin }),
  )
  if (options.binFile !== false) {
    await scratch.writeSource(`${cli}/dist/bin/aburi.mjs`, "#!/usr/bin/env node\n")
  }
  return join(scratch.root, "project")
}

function binOf(root: string): string {
  return join(root, "node_modules", "@aburi", "cli", "dist", "bin", "aburi.mjs")
}

describe("resolve-cli-bin.mjs", () => {
  it("prints the bin of the @aburi/cli installed in the working directory", async () => {
    const root = await installed({ bin: { aburi: "./dist/bin/aburi.mjs" } })
    expect(await runFrom(root)).toMatchObject({ status: 0, stdout: binOf(root) })
  })

  it("anchors on the working directory, not on its own location", async () => {
    const empty = scratch.root
    const { status, stderr } = await runFrom(empty)
    expect(status).toBe(2)
    expect(stderr).toContain("not resolvable")
    expect(stderr).toContain(empty)
    expect(stderr).toContain("cli=dlx")
  })

  it.each([
    [
      "a bin file that is not there, saying a bin is build output",
      { bin: { aburi: "./dist/bin/aburi.mjs" }, binFile: false },
      () => ["does not exist", "build the workspace"],
    ],
    [
      "a bin map with no aburi command",
      { bin: { somethingElse: "./dist/bin/aburi.mjs" } },
      () => ['no "aburi" command'],
    ],
    [
      "a string bin, which npm would name after the package rather than `aburi`",
      { bin: "./dist/bin/aburi.mjs" },
      () => ['no "aburi" command'],
    ],
    [
      "a manifest that does not parse, naming it",
      { manifest: '{"name": "@aburi/cli",' },
      (root: string) => [
        join(root, "node_modules", "@aburi", "cli", "package.json"),
        "ERR_INVALID_PACKAGE_CONFIG",
      ],
    ],
  ])("is exit 2, in one line, on %s", async (_, options, fragments) => {
    const root = await installed(options)
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr.trimEnd().split("\n")).toHaveLength(1)
    for (const fragment of fragments(root)) expect(stderr).toContain(fragment)
  })

  it("answers with the real path when the working directory is reached through a symlink", async (ctx) => {
    const root = await installed({ bin: { aburi: "./dist/bin/aburi.mjs" } })
    const link = join(scratch.root, "linked")
    try {
      await symlink(root, link, "junction")
    } catch {
      ctx.skip()
      return
    }
    expect(await runFrom(link)).toMatchObject({ status: 0, stdout: binOf(root) })
  })
})
