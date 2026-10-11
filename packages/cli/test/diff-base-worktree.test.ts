import { appendFile, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult } from "@aburi/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CliError, EXIT, runDiff } from "../src"
import { commitAll, fakeGit, git, initRepository, refusedBy } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-base-worktree")

afterEach(() => {
  vi.unstubAllEnvs()
})

function tempDirectoryAt(directory: string): void {
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, directory)
}

/** A TypeScript repository whose one commit declares `one()`. */
async function repository(directory: string, manifest = true): Promise<void> {
  await initRepository(directory)
  if (manifest) await writePackageJson(directory, { name: "demo", private: true })
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, ".gitignore", "out/\n.worktrees/\n.tmp/\n")
  await writeFileAt(directory, "src/one.ts", "export function one(): number { return 1 }\n")
  await commitAll(directory, "c1")
}

async function addFunction(directory: string, file: string, name: string): Promise<void> {
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await commitAll(directory, `add ${name}`)
}

async function diffIn(cwd: string, refSpec: string, failOn = "added") {
  const log = recordingLogger()
  const report = await runDiff({
    cwd,
    refSpec,
    outputDir: resolve(workspace.root, "out"),
    failOn,
    warn: log.warn,
  })
  const diff = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
  return { report, diff, warnings: log.warnings }
}

const ADDED_ONE = { clause: { token: "added", threshold: null }, observed: 1 }

describe("aburi diff — where the base revision is checked out", () => {
  it("diffs a linked worktree kept inside the main checkout, not the main checkout", async () => {
    const main = resolve(workspace.root, "demo")
    await repository(main)
    await git(["worktree", "add", "-q", "-b", "feat", ".worktrees/feat"], main)
    const feat = resolve(main, ".worktrees", "feat")
    await addFunction(feat, "src/feat.ts", "featOnly")

    const { report, warnings } = await diffIn(feat, "main..feat")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toEqual(ADDED_ONE)
    expect(report.faultedScans).toEqual([])
    expect(warnings).toEqual([])
  })

  it("diffs a repository nested in another without reading every Symbol as moved", async () => {
    await initRepository(workspace.root)
    const inner = resolve(workspace.root, "demo")
    await repository(inner)
    await addFunction(inner, "src/one.ts", "two")

    const { report, warnings } = await diffIn(inner, "HEAD~1..HEAD", "moved")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([])
  })

  it("scans the base revision when the temporary directory is inside the repository", async () => {
    await repository(workspace.root)
    await addFunction(workspace.root, "src/one.ts", "two")
    const inside = resolve(workspace.root, ".tmp")
    await mkdir(inside)
    tempDirectoryAt(inside)

    const { report, warnings } = await diffIn(workspace.root, "HEAD~1..HEAD")

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toEqual(ADDED_ONE)
    expect(report.faultedScans).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe("aburi diff — the base checkout describes the same Components as the head", () => {
  it.each([
    ["only the checkout directory differs", "demo", ""],
    ["the workspace is named like the run's own output directories", "base-out", ""],
    ["the command ran in a subdirectory of the workspace", "demo", "src"],
  ])("reports no Component change when %s", async (_, name, below) => {
    const root = resolve(workspace.root, name)
    await repository(root, false)

    const { diff, warnings, report } = await diffIn(resolve(root, below), "HEAD..HEAD")

    expect(diff.summary).toMatchObject({ componentsAdded: 0, componentsRemoved: 0 })
    expect(warnings).toEqual([])
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("checks a workspace named `@` out under a name git can spell, so the scan's own error surfaces", async () => {
    const root = resolve(workspace.root, "@")
    await repository(root, false)

    const error = await errorFrom(CliError, () => diffIn(root, "HEAD..HEAD"))

    expect(error.message).toMatch(/Cannot derive a Component id from directory name/)
  })
})

describe("aburi diff — cleaning up the base checkout", () => {
  it("removes the base worktree even when the base scan fails", async () => {
    await repository(workspace.root)
    await writeFileAt(workspace.root, "package.json", '{ "name": "broken", }')
    await commitAll(workspace.root, "break the manifest")
    await writePackageJson(workspace.root, { name: "demo", private: true })

    await expect(diffIn(workspace.root, "HEAD..HEAD")).rejects.toThrow(/Failed to parse JSON/)

    const listing = await git(["worktree", "list", "--porcelain"], workspace.root)
    expect(listing.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1)
  })

  it("does not remove a worktree that `worktree add` never created", async () => {
    const { runner, asked } = fakeGit({
      handlers: {
        "worktree add": refusedBy("fatal: could not create work tree dir"),
        "worktree remove": refusedBy("worktree remove must not be reached"),
      },
    })
    const log = recordingLogger()

    const error = await errorFrom(Error, () =>
      runDiff({ cwd: workspace.root, refSpec: "main..HEAD", git: runner, warn: log.warn }),
    )

    expect(error.message).toMatch(/could not create work tree dir/)
    expect(asked).not.toContain("worktree remove")
    expect(log.warnings.join("\n")).not.toContain("git worktree cleanup failed")
  })

  it("refuses, as a bug in Aburi, a base scan that roots outside its worktree", async () => {
    const demo = resolve(workspace.root, "demo")
    await mkdir(resolve(demo, ".git"), { recursive: true })
    await writeConfig(demo, TYPESCRIPT)
    const outer = resolve(workspace.root, "outer")
    await writeFileAt(outer, "pnpm-workspace.yaml", "packages: []\n")
    await mkdir(resolve(outer, "tmp"))
    tempDirectoryAt(resolve(outer, "tmp"))
    const worktrees: string[] = []
    const { runner } = fakeGit({
      onWorktreeAdd: async (worktreeDir) => {
        worktrees.push(worktreeDir)
        await writeFileAt(worktreeDir, "src/one.ts", "export function one() { return 1 }\n")
      },
    })

    const error = await errorFrom(CliError, () =>
      runDiff({ cwd: demo, refSpec: "main..HEAD", git: runner, warn: () => {} }),
    )

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(
      `Internal error while scanning base ref "main": the scan rooted at ${outer} instead of the worktree ${worktrees[0]}`,
    )
  })
})
