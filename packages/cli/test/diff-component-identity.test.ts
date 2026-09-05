import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, resolve } from "node:path"
import type { DiffResult } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff } from "../src"

/**
 * A ref diff scans two checkouts of one workspace, and the temporary directory the base one
 * lives in must not change what that workspace is called. Component detection reads the
 * directory name for a Component rooted at the workspace root (component-detect.md §4.1), so a
 * worktree at a fixed path named `base` gave the two sides different Component ids: a workspace
 * declaring neither a package name nor explicit `components[]` reported one Component added and
 * one removed on every run. The rule and its two exceptions are cli-spec.md §6.4 step 2.
 */

let scratch = ""

const CONFIG_SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

/**
 * A workspace with no `package.json`, so nothing declares a Component name and detection has
 * only the directory to go on — the case the phantom add/remove was visible in.
 *
 * The `.git` file is what a real `git worktree add` leaves behind, and it is what stops
 * `detectWorkspaceRoot` walking above the checkout. Without it the fixture relies on there
 * being no marker anywhere above `tmpdir`, which is a property of the machine, not the test.
 */
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

/**
 * `git` far enough to materialise the base revision: the two sides hold the same source.
 *
 * Every command `resolveViaGit` issues is modelled, and anything else throws rather than
 * answering success — the real `defaultGitRunner` rejects on a non-zero exit, and a fake that
 * cannot fail is a fake that covers a newly added git call with nothing. `worktree add` without
 * a path throws for the same reason: `args[3] ?? ""` would resolve against `process.cwd()` and
 * write the fixture into the developer's own checkout if the argument order ever changed.
 */
function makeGit(onAdd?: (worktreeDir: string) => void): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "rev-parse --verify") return { stdout: "abc\n", stderr: "" }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      if (key === "diff --find-renames") return { stdout: "", stderr: "" }
      if (key === "worktree remove") return { stdout: "", stderr: "" }
      if (key === "worktree add") {
        const worktreeDir = args[3]
        if (worktreeDir === undefined) {
          throw new Error(`fake git: "worktree add" without a path: ${args.join(" ")}`)
        }
        onAdd?.(worktreeDir)
        await writeWorkspace(worktreeDir)
        return { stdout: "", stderr: "" }
      }
      throw new Error(`fake git: unmodelled command: ${args.join(" ")}`)
    },
  }
}

interface DiffRun {
  diff: DiffResult
  /** Every path handed to `worktree add`, in order. */
  worktreePaths: string[]
  warnings: string[]
  exitCode: number
}

/**
 * One ref diff, with everything the command says collected rather than discarded.
 *
 * `warn` is the sink for cleanup failures, rename-collection failures and — through
 * `runScanInDir` — every scan incident from both sides. Dropping it would leave
 * `componentsAdded: 0` to be satisfied just as well by two sides that are equally broken, so
 * the warnings and the exit code are asserted beside the counts.
 */
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
    // Both halves of the path are asserted: the leaf is what Component detection reads, and the
    // `base/` level above it is what keeps the checkout from landing on the run's own temporary
    // output directories. Flattening the path back would leave the leaf assertion green.
    await writeWorkspace(scratch)

    const run = await runRefDiff(scratch, resolve(scratch, "out"))

    expect(run.worktreePaths.map((path) => [basename(dirname(path)), basename(path)])).toEqual([
      ["base", basename(scratch)],
    ])
  })

  it("keeps the base checkout clear of the run's own output directories", async () => {
    // The one workspace name that collides: flat, the base checkout and the base scan's output
    // directory would be the same path, so the scan would write its IR into its own checkout.
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
    // `git worktree add <parent>/@` fails with `fatal: not a git repository:
    // <repo>/.git/worktrees/@`, which reads as the reader's own repository being broken.
    // Substituting is safe rather than lucky: `@` kebab-cases to nothing, so this workspace has
    // no valid Component id from detection either way, and the head scan says exactly that.
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
    // `resolveWorkspaceRoot(cwd)` rather than `cwd`: the head scan mints its ids from the
    // workspace root, so a run started in a subdirectory has to name the root too. Under
    // `basename(cwd)` the base side would be a Component called `sub` and the defect would be
    // back for anyone running `aburi diff` from inside a package.
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
