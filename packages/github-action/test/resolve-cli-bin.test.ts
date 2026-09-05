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

/**
 * Run the resolver the way `action.yml` does — as a process, from a working directory of the
 * caller's choosing — so what is asserted is the contract the shell step depends on: the path on
 * stdout, the reason on stderr, and the exit code between them.
 */
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

/**
 * A temporary directory, resolved through `realpath`.
 *
 * macOS's `tmpdir()` is a symlink (`/var` → `/private/var`), and Node reports `process.cwd()`
 * resolved — so a fixture path kept as handed out disagrees with every path the child process
 * prints, and the assertions fail there and only there.
 */
async function workspace(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  workspaces.push(root)
  return root
}

/**
 * A workspace holding one installed `@aburi/cli`, described by the manifest fields under test.
 * `bin` absent writes no `bin` field at all; `binFile: false` writes the manifest but not the file
 * it points at, which is the state of a workspace that installed but has not built.
 */
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
    // This repository has @aburi/cli installed, and the script lives inside it. Resolution from a
    // temporary directory that holds no such package therefore has to fail — if it did not, the
    // script would be answering with its own tree, and `working-directory` would mean nothing.
    const empty = await workspace("aburi-resolve-empty-")
    const { status, stderr } = await runFrom(empty)
    expect(status).toBe(2)
    expect(stderr).toContain("not resolvable")
    expect(stderr).toContain(empty)
    expect(stderr).toContain("cli=dlx")
  })

  it("says the bin is build output when the manifest points at a file that is not there", async () => {
    // The state of a workspace that ran `pnpm install` and no build. Without this check the miss
    // surfaces later as the CLI's own exit 1 — a runtime error, which sends the reader looking at
    // their code instead of at their pipeline.
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
    // Node's own resolver rejects the manifest first, with ERR_INVALID_PACKAGE_CONFIG — which is
    // why the reason is carried through verbatim rather than replaced by advice: the advice for a
    // missing package ("install it") is wrong here, and the error code is what says so.
    const root = await fixture({ manifest: '{"name": "@aburi/cli",' })
    const { status, stderr } = await runFrom(root)
    expect(status).toBe(2)
    expect(stderr).toContain(join(root, "node_modules", "@aburi", "cli", "package.json"))
    expect(stderr).toContain("ERR_INVALID_PACKAGE_CONFIG")
  })

  it("reports every failure on a single line", async () => {
    // `::error::` renders one line in the Checks UI. A message that wraps loses everything after
    // the first newline exactly where the reader needs it.
    const empty = await workspace("aburi-resolve-oneline-")
    const { stderr } = await runFrom(empty)
    expect(stderr.trimEnd().split("\n")).toHaveLength(1)
  })

  it("answers with the real path when the working directory is reached through a symlink", async (ctx) => {
    // What `process.cwd()` reports is resolved, so the answer is a real path however the caller
    // arrived. This is macOS's default state rather than an exotic one — `tmpdir()` there is
    // `/var` → `/private/var` — and it is why the fixtures above go through `realpath`.
    const root = await fixture({ bin: { aburi: "./dist/bin/aburi.mjs" } })
    const link = join(await workspace("aburi-resolve-link-"), "linked")
    try {
      await symlink(root, link, "junction")
    } catch {
      // Creating one needs a privilege Windows does not grant by default. The behaviour under
      // test is the platform's, not ours, so there is nothing to assert where it cannot be set up.
      ctx.skip()
      return
    }
    const { status, stdout } = await runFrom(link)
    expect(status).toBe(0)
    expect(stdout).toBe(join(root, "node_modules", "@aburi", "cli", "dist", "bin", "aburi.mjs"))
  })

  it("keeps the @aburi/cli manifest resolvable and its bin where the resolver looks", async () => {
    // Parity with the real package, in the pattern the DIFF_JSON_FILENAME tests already use here.
    // `cli: workspace` rests on two things `packages/cli/package.json` happens to declare:
    // `exports["./package.json"]`, without which resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED,
    // and `bin.aburi`. Neither has another consumer in this repository, so neither is otherwise
    // protected from a tidy-up.
    const requireFrom = createRequire(`${process.cwd()}/`)
    const manifestPath = requireFrom.resolve("@aburi/cli/package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: { aburi?: string } }
    expect(manifest.bin?.aburi).toBeDefined()
    expect(resolve(dirname(manifestPath), manifest.bin?.aburi ?? "")).toMatch(
      /dist[\\/]bin[\\/]aburi\.mjs$/,
    )
  })
})
