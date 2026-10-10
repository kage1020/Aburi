import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import type { DiffResult } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff } from "../src"
import { fakeGit } from "./fixtures"

let scratch = ""

const CONFIG_SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

async function writeWorkspace(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(
    resolve(directory, ".git"),
    "gitdir: /nonexistent/.git/worktrees/fixture\n",
    "utf8",
  )
  await writeFile(
    resolve(directory, "aburi.json"),
    JSON.stringify({ $schema: CONFIG_SCHEMA, languages: ["lang-typescript"] }),
    "utf8",
  )
  await writeFile(resolve(directory, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
}

function makeGit(onAdd?: (worktreeDir: string) => void): GitRunner {
  return fakeGit({
    unmodelled: "throw",
    onWorktreeAdd: async (worktreeDir) => {
      onAdd?.(worktreeDir)
      await writeWorkspace(worktreeDir)
    },
  }).runner
}

interface DiffRun {
  diff: DiffResult
  worktreePaths: string[]
  warnings: string[]
  exitCode: number
}

async function runRefDiff(cwd: string, outputDir: string): Promise<DiffRun> {
  const worktreePaths: string[] = []
  const warnings: string[] = []
  const report = await runDiff({
    cwd,
    refSpec: "main..HEAD",
    git: makeGit((path) => worktreePaths.push(path)),
    outputDir,
    format: "json",
    warn: (line) => warnings.push(line),
  })
  expect(report.diffJsonPath).not.toBeNull()
  const diff = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
  return { diff, worktreePaths, warnings, exitCode: report.exitCode }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-identity-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff refspec mode — Component identity across the two checkouts", () => {
  it("reports no component change when only the checkout directory differs", async () => {
    await writeWorkspace(scratch)

    const run = await runRefDiff(scratch, resolve(scratch, "out"))

    expect(run.diff.summary.componentsAdded).toBe(0)
    expect(run.diff.summary.componentsRemoved).toBe(0)
    expect(run.diff.components.added).toEqual([])
    expect(run.diff.components.removed).toEqual([])
    expect(run.warnings).toEqual([])
    expect(run.exitCode).toBe(EXIT.SUCCESS)
  })

  it("materialises the base under `base/`, named after the head workspace directory", async () => {
    await writeWorkspace(scratch)

    const run = await runRefDiff(scratch, resolve(scratch, "out"))

    expect(run.worktreePaths.map((path) => [basename(dirname(path)), basename(path)])).toEqual([
      ["base", basename(scratch)],
    ])
  })

  it("keeps the base checkout clear of the run's own output directories", async () => {
    const workspace = resolve(scratch, "base-out")
    await writeWorkspace(workspace)

    const run = await runRefDiff(workspace, resolve(scratch, "out"))

    expect(run.worktreePaths.map((path) => [basename(dirname(path)), basename(path)])).toEqual([
      ["base", "base-out"],
    ])
    expect(run.diff.summary.componentsAdded).toBe(0)
    expect(run.diff.summary.componentsRemoved).toBe(0)
    expect(run.warnings).toEqual([])
  })

  it("substitutes the one leaf git cannot spell, so the reader gets the scan's error", async () => {
    const workspace = resolve(scratch, "@")
    await writeWorkspace(workspace)
    const worktreePaths: string[] = []

    const thrown = await runDiff({
      cwd: workspace,
      refSpec: "main..HEAD",
      git: makeGit((path) => worktreePaths.push(path)),
      outputDir: resolve(scratch, "out"),
      format: "json",
      warn: () => {},
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(worktreePaths.map((path) => basename(path))).toEqual(["base"])
    expect((thrown as Error).message).toMatch(/Cannot derive a Component id from directory name/)
  })

  it("names the worktree after the workspace root, not the directory the command ran in", async () => {
    await writeWorkspace(scratch)
    const inner = resolve(scratch, "sub")
    await mkdir(inner, { recursive: true })
    await writeFile(resolve(inner, "b.ts"), "export function beta() { return 2 }\n", "utf8")

    const run = await runRefDiff(inner, resolve(scratch, "out"))

    expect(run.worktreePaths.map((path) => basename(path))).toEqual([basename(scratch)])
    expect(run.diff.summary.componentsAdded).toBe(0)
    expect(run.diff.summary.componentsRemoved).toBe(0)
  })
})
