import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-cli-bin.mjs",
)

interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

async function runFrom(cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT], { cwd })
    return { status: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      status: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
}

const workspaces: string[] = []

async function workspace(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  workspaces.push(root)
  return root
}

async function fixture(options: {
  manifest?: unknown
  bin?: unknown
  binFile?: boolean
}): Promise<string> {
  const root = await workspace("aburi-resolve-")
  const packageDir = join(root, "node_modules", "@aburi", "cli")
  await mkdir(join(packageDir, "dist", "bin"), { recursive: true })
  const manifest =
    options.manifest ??
    ({
      name: "@aburi/cli",
      version: "0.0.0-test",
      ...(options.bin === undefined ? {} : { bin: options.bin }),
    } as unknown)
  await writeFile(
    join(packageDir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  )
  if (options.binFile !== false) {
    await writeFile(join(packageDir, "dist", "bin", "aburi.mjs"), "#!/usr/bin/env node\n")
  }
  return root
}

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("resolve-cli-bin.mjs", () => {
  it("prints the bin of the @aburi/cli installed in the working directory", async () => {
    const root = await fixture({ bin: { aburi: "./dist/bin/aburi.mjs" } })
    const { status, stdout } = await runFrom(root)
    expect(status).toBe(0)
    expect(stdout).toBe(join(root, "node_modules", "@aburi", "cli", "dist", "bin", "aburi.mjs"))
  })

  it("anchors on the working directory, not on its own location", async () => {
    const empty = await workspace("aburi-resolve-empty-")
    const { status, stderr } = await runFrom(empty)
    expect(status).toBe(2)
    expect(stderr).toContain("not resolvable")
    expect(stderr).toContain(empty)
    expect(stderr).toContain("cli=dlx")
  })

  it("says the bin is build output when the manifest points at a file that is not there", async () => {
    const root = await fixture({ bin: { aburi: "./dist/bin/aburi.mjs" }, binFile: false })
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr).toContain("does not exist")
    expect(stderr).toContain("build the workspace")
  })

  it("rejects a bin map with no aburi command", async () => {
    const root = await fixture({ bin: { somethingElse: "./dist/bin/aburi.mjs" } })
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr).toContain('no "aburi" command')
  })

  it("rejects a string bin, which npm would name after the package rather than `aburi`", async () => {
    const root = await fixture({ bin: "./dist/bin/aburi.mjs" })
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr).toContain('no "aburi" command')
  })

  it("names the manifest when it does not parse", async () => {
    const root = await fixture({ manifest: '{"name": "@aburi/cli",' })
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr).toContain(join(root, "node_modules", "@aburi", "cli", "package.json"))
    expect(stderr).toContain("ERR_INVALID_PACKAGE_CONFIG")
  })

  it("reports every failure on a single line", async () => {
    const empty = await workspace("aburi-resolve-oneline-")
    const { stderr } = await runFrom(empty)
    expect(stderr.trimEnd().split("\n")).toHaveLength(1)
  })

  it("answers with the real path when the working directory is reached through a symlink", async (ctx) => {
    const root = await fixture({ bin: { aburi: "./dist/bin/aburi.mjs" } })
    const link = join(await workspace("aburi-resolve-link-"), "linked")
    try {
      await symlink(root, link, "junction")
    } catch {
      ctx.skip()
      return
    }
    const { status, stdout } = await runFrom(link)
    expect(status).toBe(0)
    expect(stdout).toBe(join(root, "node_modules", "@aburi", "cli", "dist", "bin", "aburi.mjs"))
  })

  it("keeps the @aburi/cli manifest resolvable and its bin where the resolver looks", async () => {
    const requireFrom = createRequire(`${process.cwd()}/`)
    const manifestPath = requireFrom.resolve("@aburi/cli/package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: { aburi?: string } }
    expect(manifest.bin?.aburi).toBeDefined()
    expect(resolve(dirname(manifestPath), manifest.bin?.aburi ?? "")).toMatch(
      /dist[\\/]bin[\\/]aburi\.mjs$/,
    )
  })
})
