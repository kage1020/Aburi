import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { CliError } from "../src/errors"
import { fakeGit, realGit as git, probeRealGit } from "./fixtures"

let scratch = ""
const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const
let savedTemp: Partial<Record<(typeof TEMP_VARIABLES)[number], string>> = {}
let gitProbeError: unknown = null

async function repository(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
  await writeFile(resolve(directory, "package.json"), '{"name":"demo","private":true}\n')
  await writeFile(resolve(directory, "aburi.json"), '{"languages":["lang-typescript"]}\n')
  await writeFile(resolve(directory, ".gitignore"), "out/\n.worktrees/\n.tmp/\n")
  await writeFile(resolve(directory, "src/one.ts"), "export function one(): number { return 1 }\n")
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "c1"], directory)
}

async function addFunction(directory: string, file: string, name: string): Promise<void> {
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", `add ${name}`], directory)
}

function tempAt(directory: string): void {
  for (const name of TEMP_VARIABLES) process.env[name] = directory
}

async function diffIn(cwd: string, refSpec: string, failOn: string) {
  const warnings: string[] = []
  const result = await runDiff({
    cwd,
    refSpec,
    outputDir: resolve(cwd, "out"),
    failOn,
    warn: (message) => warnings.push(message),
  })
  return { ...result, warnings }
}

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-root-"))
  savedTemp = {}
  for (const name of TEMP_VARIABLES) {
    const value = process.env[name]
    if (value !== undefined) savedTemp[name] = value
  }
})

afterEach(async () => {
  for (const name of TEMP_VARIABLES) {
    const value = savedTemp[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff in a repository with something above it", () => {
  it("diffs a linked worktree kept inside the main checkout, not the main checkout", async () => {
    const main = resolve(scratch, "demo")
    await repository(main)
    await git(["worktree", "add", "-q", "-b", "feat", ".worktrees/feat"], main)
    const feat = resolve(main, ".worktrees", "feat")
    await addFunction(feat, "src/feat.ts", "featOnly")

    const result = await diffIn(feat, "main..feat", "added")

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
    expect(result.faultedScans).toEqual([])
    expect(result.exitCode).toBe(EXIT.GATE)
    expect(result.warnings).toEqual([])
  })

  it("diffs a repository nested in another without reading every Symbol as moved", async () => {
    const outer = resolve(scratch, "outer")
    await mkdir(outer)
    await git(["init", "-q", "-b", "main"], outer)
    const inner = resolve(outer, "demo")
    await repository(inner)
    await addFunction(inner, "src/one.ts", "two")

    const result = await diffIn(inner, "HEAD~1..HEAD", "moved")

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.triggered).toBeNull()
    expect(result.faultedScans).toEqual([])
    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.warnings).toEqual([])
  })

  it("scans the base revision when the temporary directory is inside the repository", async () => {
    const demo = resolve(scratch, "demo")
    await repository(demo)
    await addFunction(demo, "src/one.ts", "two")
    const inside = resolve(demo, ".tmp")
    await mkdir(inside)
    tempAt(inside)

    const result = await diffIn(demo, "HEAD~1..HEAD", "added")

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
    expect(result.faultedScans).toEqual([])
    expect(result.exitCode).toBe(EXIT.GATE)
    expect(result.warnings).toEqual([])
  })
})

describe("aburi diff whose base scan roots outside its worktree", () => {
  it("refuses the diff as a bug in Aburi, naming both directories", async () => {
    const demo = resolve(scratch, "demo")
    await mkdir(resolve(demo, ".git"), { recursive: true })
    await writeFile(resolve(demo, "aburi.json"), '{"languages":["lang-typescript"]}\n')
    const outer = resolve(scratch, "outer")
    await mkdir(resolve(outer, "tmp"), { recursive: true })
    await writeFile(resolve(outer, "pnpm-workspace.yaml"), "packages: []\n")
    tempAt(resolve(outer, "tmp"))
    const worktrees: string[] = []
    const { runner } = fakeGit({
      onWorktreeAdd: async (worktreeDir) => {
        worktrees.push(worktreeDir)
        await mkdir(resolve(worktreeDir, "src"), { recursive: true })
        await writeFile(resolve(worktreeDir, "src/one.ts"), "export function one() { return 1 }\n")
      },
    })

    const error = await runDiff({
      cwd: demo,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(demo, "out"),
      warn: () => {},
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("runtime-error")
    expect((error as CliError).message).toContain(
      `Internal error while scanning base ref "main": the scan rooted at ${outer} instead of the worktree ${worktrees[0]}`,
    )
  })
})
