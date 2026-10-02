import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { parseSubmodulePaths } from "../src/commands/diff"
import { CliError } from "../src/errors"
import { realGit as git, probeRealGit } from "./fixtures"

/**
 * `git worktree add` does not populate submodules, so the base side of a ref diff sees each one
 * as an empty directory while the head side walks into the checked-out copy. `cli-spec.md`
 * §6.4.1 lists submodule-aware diff as unsupported; these pin that the run says so and keeps the
 * two sides agreeing, and that a sparse checkout is refused. Run against real git.
 */

let scratch = ""
let gitProbeError: unknown = null

/** A one-commit repository holding one function, to be added as a submodule. */
async function library(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
  await writeFile(
    resolve(directory, "src/lib.ts"),
    "export function libFn(): number { return 1 }\n",
  )
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "lib"], directory)
}

/** The issue's layout: a repository whose first commit adds `lib` as a submodule at `at`. */
async function superproject(directory: string, lib: string, at: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
  await writeFile(resolve(directory, "package.json"), '{"name":"demo","private":true}\n')
  await writeFile(resolve(directory, "aburi.json"), '{"languages":["lang-typescript"]}\n')
  await writeFile(resolve(directory, ".gitignore"), "out/\n")
  await writeFile(
    resolve(directory, "src/main.ts"),
    "export function main(): number { return 1 }\n",
  )
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, at], directory)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "c1"], directory)
}

async function commitFunction(directory: string, file: string, name: string): Promise<void> {
  await mkdir(resolve(directory, file, ".."), { recursive: true })
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", `add ${name}`], directory)
}

async function diffIn(cwd: string) {
  const warnings: string[] = []
  const result = await runDiff({
    cwd,
    refSpec: "HEAD~1..HEAD",
    outputDir: resolve(cwd, "out"),
    failOn: "added",
    warn: (message) => warnings.push(message),
  })
  return { ...result, warnings }
}

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-submodule-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff in a repository with a submodule", () => {
  it("leaves an unchanged submodule out of both sides, and says so", async () => {
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await superproject(demo, lib, "libs/sub")
    await commitFunction(demo, "src/main.ts", "main2")

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
    expect(result.exitCode).toBe(EXIT.GATE)
    expect(result.warnings).toEqual([
      "⚠ Submodules detected: libs/sub. Submodule-aware diff is not yet supported, so their files are left out of both sides.",
    ])
  })

  it("leaves out only the submodule when its path holds glob characters", async () => {
    // Unescaped, `libs/[x]/**` is a character class that matches `libs/x/**`, and `keep`
    // would vanish from the head alongside the submodule.
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await superproject(demo, lib, "libs/[x]")
    await commitFunction(demo, "libs/x/keep.ts", "keep")

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("Submodules detected: libs/[x].")
  })

  it("warns about nothing in a repository without submodules", async () => {
    const demo = resolve(scratch, "demo")
    await mkdir(resolve(demo, "src"), { recursive: true })
    await git(["init", "-q", "-b", "main"], demo)
    await writeFile(resolve(demo, "package.json"), '{"name":"demo","private":true}\n')
    await writeFile(resolve(demo, "aburi.json"), '{"languages":["lang-typescript"]}\n')
    await writeFile(resolve(demo, ".gitignore"), "out/\n")
    await writeFile(resolve(demo, "src/main.ts"), "export function main(): number { return 1 }\n")
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "c1"], demo)
    await commitFunction(demo, "src/main.ts", "main2")

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.warnings).toEqual([])
  })
})

describe("aburi diff in a sparse checkout", () => {
  it("refuses to run, with the way out", async () => {
    const demo = resolve(scratch, "demo")
    await mkdir(resolve(demo, "src"), { recursive: true })
    await git(["init", "-q", "-b", "main"], demo)
    await writeFile(resolve(demo, "aburi.json"), '{"languages":["lang-typescript"]}\n')
    await writeFile(resolve(demo, "src/main.ts"), "export function main(): number { return 1 }\n")
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "c1"], demo)
    await commitFunction(demo, "src/main.ts", "main2")
    await git(["sparse-checkout", "set", "src"], demo)

    const run = diffIn(demo)

    await expect(run).rejects.toBeInstanceOf(CliError)
    await expect(run).rejects.toMatchObject({
      message:
        "Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable",
      code: "runtime-error",
    })
  })
})

describe("parseSubmodulePaths", () => {
  it("keeps gitlinks only, once each, whatever the path holds", () => {
    const stdout = [
      "100644 aaa 0\tsrc/main.ts",
      "160000 bbb 0\tlibs/sub",
      "160000 ccc 1\tlibs/conflicted",
      "160000 ddd 2\tlibs/conflicted",
      "160000 eee 0\tlibs/a\tb\nc",
      "",
    ].join("\0")

    expect(parseSubmodulePaths(stdout)).toEqual(["libs/a\tb\nc", "libs/conflicted", "libs/sub"])
  })
})
