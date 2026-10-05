import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resolve-refspec.mjs",
)

/**
 * Run as a process from a real checkout, because that is what `action.yml` does with it: stdout
 * is captured into the ref spec, stderr becomes annotations in the job log, and a non-zero exit
 * fails the step. Which commit is checked out is the whole question, and a mocked git would only
 * repeat the script's own idea of what the merge ref looks like.
 */
interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * What the fixtures' git and the script must not take from the environment: the repository and
 * index a commit hook names, the developer's config, and the action inputs a case leaves unset.
 */
const UNSET_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "INPUT_REFSPEC",
  "EVENT_NAME",
  "PR_BASE_SHA",
  "PR_HEAD_SHA",
  "PR_BASE_REF",
]

const workspaces: string[] = []

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "aburi-resolve-refspec-")))
  workspaces.push(dir)
  return dir
}

function environment(cwd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(cwd, "absent-gitconfig"),
    GIT_CONFIG_SYSTEM: join(cwd, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "Aburi Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Aburi Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  for (const name of UNSET_ENV) delete env[name]
  return { ...env, ...extra }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: environment(cwd) })
  return stdout.trim()
}

async function commit(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content)
  await git(cwd, ["add", "-A"])
  await git(cwd, ["commit", "-q", "-m", message])
  return git(cwd, ["rev-parse", "HEAD"])
}

/**
 * A pull request that has fallen behind its base branch, checked out as its merge ref. The base
 * branch deleted a function after the event recorded `base.sha`; the pull request deleted
 * nothing.
 */
interface PullRequest {
  readonly dir: string
  /** The event's `pull_request.base.sha`, which the base branch has since moved past. */
  readonly recordedBase: string
  /** The base branch's tip now. */
  readonly baseTip: string
  /** The event's `pull_request.head.sha`. */
  readonly head: string
  /** `refs/pull/<n>/merge`: `head` merged into `baseTip`, checked out and detached. */
  readonly merge: string
}

async function pullRequestBehindItsBase(): Promise<PullRequest> {
  const dir = await workspace()
  await git(dir, ["init", "-q", "-b", "main"])
  const recordedBase = await commit(
    dir,
    "a.ts",
    "export function kept() {}\nexport function doomed() {}\n",
    "base",
  )
  await git(dir, ["checkout", "-q", "-b", "feature"])
  const head = await commit(dir, "b.ts", "export function added() {}\n", "feature")
  await git(dir, ["checkout", "-q", "main"])
  const baseTip = await commit(dir, "a.ts", "export function kept() {}\n", "delete doomed")
  await git(dir, ["checkout", "-q", "--detach", "main"])
  await git(dir, ["merge", "-q", "--no-ff", "--no-edit", "feature"])
  const merge = await git(dir, ["rev-parse", "HEAD"])
  return { dir, recordedBase, baseTip, head, merge }
}

async function run(cwd: string, env: Record<string, string>): Promise<RunResult> {
  try {
    const done = await execFileAsync(process.execPath, [SCRIPT], {
      cwd,
      env: environment(cwd, env),
    })
    return { status: 0, stdout: done.stdout, stderr: done.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      status: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
}

function event(pr: PullRequest, name = "pull_request"): Record<string, string> {
  return { EVENT_NAME: name, PR_BASE_SHA: pr.recordedBase, PR_HEAD_SHA: pr.head }
}

/** The paths that differ between `base` and the checkout: the comparison `aburi diff` makes. */
function changedPaths(cwd: string, base: string): Promise<string> {
  return git(cwd, ["diff", "--name-status", base, "HEAD"])
}

describe("resolve-refspec.mjs", () => {
  it("compares the merge ref with its first parent, not with the base the event recorded", async () => {
    const pr = await pullRequestBehindItsBase()
    const result = await run(pr.dir, event(pr))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.baseTip}..${pr.merge}`)

    // `aburi diff` compares the base's tree with the checkout. From the parent, that is the pull
    // request's own file; from the recorded base, it is also the deletion the base branch made.
    expect(await changedPaths(pr.dir, pr.baseTip)).toBe("A\tb.ts")
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("M\ta.ts\nA\tb.ts")
  })

  it("compares a checked-out head with its merge base, whatever base.sha the event recorded", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(pr.dir, ["checkout", "-q", "--detach", pr.head])
    for (const recorded of [pr.recordedBase, pr.baseTip]) {
      const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: recorded })
      expect(result.status, `base.sha ${recorded}`).toBe(0)
      expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
    }
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("A\tb.ts")
  })

  it("compares a checked-out head that merged its base branch with the base commit it merged", async () => {
    // The pull request merges the base branch, deletion and all, after the event recorded
    // base.sha, and the base branch moves on again. Its merge base with base.sha is base.sha
    // itself; with the base branch as the clone fetched it, the commit the pull request merged.
    const pr = await pullRequestBehindItsBase()
    await git(pr.dir, ["checkout", "-q", "feature"])
    await git(pr.dir, ["merge", "-q", "--no-edit", "main"])
    const head = await commit(pr.dir, "c.ts", "export function later() {}\n", "after main")
    await git(pr.dir, ["checkout", "-q", "main"])
    const newer = await commit(pr.dir, "d.ts", "export function newer() {}\n", "main again")
    await git(pr.dir, ["update-ref", "refs/remotes/origin/main", newer])
    await git(pr.dir, ["checkout", "-q", "--detach", head])

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
    await git(pr.dir, ["update-ref", "refs/remotes/origin/main", pr.baseTip])
    await git(pr.dir, ["checkout", "-q", "--detach", pr.head])
    const missing = "0123456789abcdef0123456789abcdef01234567"
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: missing, PR_BASE_REF: "main" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
  })

  it("refuses the base branch, which is what a pull_request_target checks out by default", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(pr.dir, ["checkout", "-q", "main"])
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
    await git(pr.dir, ["checkout", "-q", "feature"])
    const pushedAgain = await commit(pr.dir, "c.ts", "export function later() {}\n", "again")
    await git(pr.dir, ["checkout", "-q", "--detach", pr.merge])
    const result = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: pushedAgain })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`The checkout is ${pr.merge}`)
    // The pull_request_target explanation is for that event; this is a plain pull_request.
    expect(result.stderr).not.toContain("Under pull_request_target")
  })

  it("says the clone is shallow when that is why a merge's parents cannot be read", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(pr.dir, ["branch", "pull-merge", pr.merge])
    const clone = await workspace()
    // A file URL, because a local path clone ignores `--depth`.
    await git(clone, [
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      "pull-merge",
      pathToFileURL(pr.dir).href,
      "checkout",
    ])
    const result = await run(join(clone, "checkout"), event(pr))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("This clone is shallow")
    expect(result.stderr).toContain("fetch-depth: 0")
  })

  it("refuses a checked-out head whose merge base with base.sha is not in the clone", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(pr.dir, ["checkout", "-q", "--detach", pr.head])
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
    const elsewhere = await workspace()
    // Stops git looking for a repository above the temp directory, which is not this test's.
    const result = await run(elsewhere, {
      ...event(pr),
      GIT_CEILING_DIRECTORIES: dirname(elsewhere),
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`Could not read the checked-out commit in ${elsewhere}`)
  })

  it("passes an explicit refspec through, without reading the checkout or the event", async () => {
    // Not a repository, and not a pull request: reaching either check would be an error.
    const elsewhere = await workspace()
    const result = await run(elsewhere, {
      INPUT_REFSPEC: "origin/main..HEAD",
      EVENT_NAME: "push",
      GIT_CEILING_DIRECTORIES: dirname(elsewhere),
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("origin/main..HEAD")
    expect(result.stderr).toBe("")
  })

  it("refuses an event that carries no pull request when refspec is empty", async () => {
    const result = await run(await workspace(), { EVENT_NAME: "push" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("event 'push' does not carry a PR base/head")
  })

  it("refuses a pull request event that is missing either SHA", async () => {
    const pr = await pullRequestBehindItsBase()
    for (const missing of ["PR_BASE_SHA", "PR_HEAD_SHA"]) {
      const result = await run(pr.dir, { ...event(pr), [missing]: "" })
      expect(result.status, `accepted an empty ${missing}`).toBe(2)
      expect(result.stderr).toContain("missing base/head SHAs; refuse to guess")
    }
  })
})
