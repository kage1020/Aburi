import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type RunResult, runScript } from "./fixtures/scripts"

const execFileAsync = promisify(execFile)

const HOOK_AND_REPOSITORY_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]

/** An environment that keeps the developer's git config and any enclosing hook out of a fixture. */
function gitTestEnv(anchor: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: resolve(anchor, "absent-gitconfig"),
    GIT_CONFIG_SYSTEM: resolve(anchor, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "Aburi Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Aburi Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  for (const name of HOOK_AND_REPOSITORY_ENV) delete env[name]
  return Object.assign(env, extra)
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  return (await execFileAsync("git", args, { cwd, env: gitTestEnv(cwd) })).stdout
}

async function initRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
}

async function commitAll(directory: string, message: string): Promise<void> {
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", message], directory)
}

const scratch = useScratchWorkspace("resolve-refspec")

const ACTION_INPUTS_UNSET = {
  INPUT_REFSPEC: undefined,
  EVENT_NAME: undefined,
  PR_BASE_SHA: undefined,
  PR_HEAD_SHA: undefined,
  PR_BASE_REF: undefined,
}

function run(cwd: string, env: Record<string, string>): Promise<RunResult> {
  return runScript("resolve-refspec.mjs", {
    cwd,
    env: { ...gitTestEnv(cwd), ...ACTION_INPUTS_UNSET, ...env },
  })
}

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(["rev-parse", rev], cwd)).trim()
}

async function commit(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content)
  await commitAll(cwd, message)
  return revParse(cwd, "HEAD")
}

/** A directory under the scratch root with no repository in it or above it. */
async function notACheckout(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = join(scratch.root, "elsewhere")
  await mkdir(dir)
  return { dir, env: { GIT_CEILING_DIRECTORIES: scratch.root } }
}

/**
 * A pull request behind its base branch, checked out as its merge ref: the base branch deleted a
 * function after the event recorded `base.sha`, and the pull request deleted nothing.
 */
interface PullRequest {
  readonly dir: string
  readonly recordedBase: string
  readonly baseTip: string
  readonly head: string
  /** `refs/pull/<n>/merge`: `head` merged into `baseTip`, checked out and detached. */
  readonly merge: string
}

async function pullRequestBehindItsBase(): Promise<PullRequest> {
  const dir = join(scratch.root, "pr")
  await initRepository(dir)
  const recordedBase = await commit(
    dir,
    "a.ts",
    "export function kept() {}\nexport function doomed() {}\n",
    "base",
  )
  await git(["checkout", "-q", "-b", "feature"], dir)
  const head = await commit(dir, "b.ts", "export function added() {}\n", "feature")
  await git(["checkout", "-q", "main"], dir)
  const baseTip = await commit(dir, "a.ts", "export function kept() {}\n", "delete doomed")
  await git(["checkout", "-q", "--detach", "main"], dir)
  await git(["merge", "-q", "--no-ff", "--no-edit", "feature"], dir)
  const merge = await revParse(dir, "HEAD")
  return { dir, recordedBase, baseTip, head, merge }
}

function event(pr: PullRequest, name = "pull_request"): Record<string, string> {
  return { EVENT_NAME: name, PR_BASE_SHA: pr.recordedBase, PR_HEAD_SHA: pr.head }
}

/** The paths that differ between `base` and the checkout: the comparison `aburi diff` makes. */
async function changedPaths(cwd: string, base: string): Promise<string> {
  return (await git(["diff", "--name-status", base, "HEAD"], cwd)).trim()
}

describe("resolve-refspec.mjs", () => {
  it("compares the merge ref with its first parent, not with the base the event recorded", async () => {
    const pr = await pullRequestBehindItsBase()
    const result = await run(pr.dir, event(pr))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.baseTip}..${pr.merge}`)

    // From the parent, the checkout differs by the pull request's own file; from the recorded
    // base, also by the deletion the base branch made.
    expect(await changedPaths(pr.dir, pr.baseTip)).toBe("A\tb.ts")
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("M\ta.ts\nA\tb.ts")
  })

  it("compares a checked-out head with its merge base, whatever base.sha the event recorded", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    for (const recorded of [pr.recordedBase, pr.baseTip]) {
      const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: recorded })
      expect(result.status, `base.sha ${recorded}`).toBe(0)
      expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
    }
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("A\tb.ts")
  })

  it("compares a checked-out head that merged its base branch with the base commit it merged", async () => {
    // The pull request merges the base branch after the event recorded base.sha, and the base
    // branch moves on again: only the tracking ref finds the commit the pull request merged.
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "feature"], pr.dir)
    await git(["merge", "-q", "--no-edit", "main"], pr.dir)
    const head = await commit(pr.dir, "c.ts", "export function later() {}\n", "after main")
    await git(["checkout", "-q", "main"], pr.dir)
    const newer = await commit(pr.dir, "d.ts", "export function newer() {}\n", "main again")
    await git(["update-ref", "refs/remotes/origin/main", newer], pr.dir)
    await git(["checkout", "-q", "--detach", head], pr.dir)

    const result = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: head, PR_BASE_REF: "main" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.baseTip}..${head}`)
    expect(result.stderr).toContain(`merge base with origin/main, ${pr.baseTip}`)
    expect(await changedPaths(pr.dir, pr.baseTip)).toBe("A\tb.ts\nA\tc.ts")

    // Without the tracking ref, base.sha is all there is, and the base branch's deletion is in
    // the comparison.
    const recordedOnly = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: head })
    expect(recordedOnly.stdout).toBe(`${pr.recordedBase}..${head}`)
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("M\ta.ts\nA\tb.ts\nA\tc.ts")
  })

  it("finds a checked-out head's merge base from the tracking ref when base.sha is not in the clone", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["update-ref", "refs/remotes/origin/main", pr.baseTip], pr.dir)
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    const missing = "0123456789abcdef0123456789abcdef01234567"
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: missing, PR_BASE_REF: "main" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
  })

  it("refuses the base branch, which is what a pull_request_target checks out by default", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "main"], pr.dir)
    const result = await run(pr.dir, event(pr, "pull_request_target"))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^::error::/)
    expect(result.stderr).toContain(`The checkout is ${pr.baseTip}`)
    expect(result.stderr).toContain(`head ${pr.head}`)
    expect(result.stderr).toContain("'refspec' input")
    expect(result.stderr).toContain(
      "Under pull_request_target, actions/checkout checks out the base",
    )
    expect(result.stderr).not.toContain("shallow")
  })

  it("refuses a merge of some other commit, such as the merge ref of an earlier push", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "feature"], pr.dir)
    const pushedAgain = await commit(pr.dir, "c.ts", "export function later() {}\n", "again")
    await git(["checkout", "-q", "--detach", pr.merge], pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: pushedAgain })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`The checkout is ${pr.merge}`)
    expect(result.stderr).not.toContain("Under pull_request_target")
  })

  it("says the clone is shallow when that is why a merge's parents cannot be read", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["branch", "pull-merge", pr.merge], pr.dir)
    // A file URL, because a local path clone ignores `--depth`.
    await git(
      [
        "clone",
        "-q",
        "--depth",
        "1",
        "--branch",
        "pull-merge",
        pathToFileURL(pr.dir).href,
        "clone",
      ],
      scratch.root,
    )
    const result = await run(join(scratch.root, "clone"), event(pr))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("This clone is shallow")
    expect(result.stderr).toContain("fetch-depth: 0")
  })

  it("refuses a checked-out head whose merge base with base.sha is not in the clone", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    const missing = "0123456789abcdef0123456789abcdef01234567"
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: missing })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(
      `Could not find the merge base of the pull request's base ${missing}`,
    )
  })

  it("refuses a working directory that is not a checkout", async () => {
    const pr = await pullRequestBehindItsBase()
    const elsewhere = await notACheckout()
    const result = await run(elsewhere.dir, { ...event(pr), ...elsewhere.env })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`Could not read the checked-out commit in ${elsewhere.dir}`)
  })

  it("passes an explicit refspec through, without reading the checkout or the event", async () => {
    // Not a repository, and not a pull request: reaching either check would be an error.
    const elsewhere = await notACheckout()
    const result = await run(elsewhere.dir, {
      INPUT_REFSPEC: "origin/main..HEAD",
      EVENT_NAME: "push",
      ...elsewhere.env,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("origin/main..HEAD")
    expect(result.stderr).toBe("")
  })

  it("refuses an event that carries no pull request when refspec is empty", async () => {
    const result = await run(scratch.root, { EVENT_NAME: "push" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("event 'push' does not carry a PR base/head")
  })

  it.each([
    "PR_BASE_SHA",
    "PR_HEAD_SHA",
  ])("refuses a pull request event whose %s is empty", async (missing) => {
    const pr = await pullRequestBehindItsBase()
    const result = await run(pr.dir, { ...event(pr), [missing]: "" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("missing base/head SHAs; refuse to guess")
  })
})
