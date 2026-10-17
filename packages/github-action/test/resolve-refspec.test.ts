import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  commitAll,
  git,
  gitTestEnv,
  initRepository,
  useScratchWorkspace,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { type RunResult, runScript } from "./fixtures/scripts"

const scratch = useScratchWorkspace("resolve-refspec")

/** A well-formed SHA that no fixture repository contains. */
const MISSING_SHA = "0123456789abcdef0123456789abcdef01234567"

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

function errorLine(result: RunResult): string | undefined {
  return result.stderr.split("\n").find((line) => line.startsWith("::error::"))
}

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(["rev-parse", rev], cwd)).trim()
}

async function commit(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content)
  await commitAll(cwd, message)
  return revParse(cwd, "HEAD")
}

async function setTrackingRef(cwd: string, sha: string): Promise<void> {
  await git(["update-ref", "refs/remotes/origin/main", sha], cwd)
}

async function dropTrackingRef(cwd: string): Promise<void> {
  await git(["update-ref", "-d", "refs/remotes/origin/main"], cwd)
}

/** A directory under the scratch root with no repository in it or above it. */
async function notACheckout(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = join(scratch.root, "elsewhere")
  await mkdir(dir)
  return { dir, env: { GIT_CEILING_DIRECTORIES: scratch.root } }
}

/**
 * A pull request behind its base branch, checked out as its merge ref: the base branch deleted a
 * function after the event recorded `base.sha`, and the pull request deleted nothing. The clone
 * has `origin/main` at the base branch's tip, as a full clone fetches it.
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
  await setTrackingRef(dir, baseTip)
  await git(["checkout", "-q", "--detach", "main"], dir)
  await git(["merge", "-q", "--no-ff", "--no-edit", "feature"], dir)
  const merge = await revParse(dir, "HEAD")
  return { dir, recordedBase, baseTip, head, merge }
}

function event(pr: PullRequest, name = "pull_request"): Record<string, string> {
  return {
    EVENT_NAME: name,
    PR_BASE_SHA: pr.recordedBase,
    PR_HEAD_SHA: pr.head,
    PR_BASE_REF: "main",
  }
}

/** The paths that differ between `base` and the checkout: the comparison `aburi diff` makes. */
async function changedPaths(cwd: string, base: string): Promise<string> {
  return (await git(["diff", "--name-status", base, "HEAD"], cwd)).trim()
}

describe("resolve-refspec.mjs, on a merge", () => {
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

  it("reads the event's SHAs whatever their case", async () => {
    const pr = await pullRequestBehindItsBase()
    const result = await run(pr.dir, {
      ...event(pr),
      PR_BASE_SHA: pr.recordedBase.toUpperCase(),
      PR_HEAD_SHA: pr.head.toUpperCase(),
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.baseTip}..${pr.merge}`)
  })

  it("refuses a merge of the head into a branch other than its base", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "-b", "other", pr.recordedBase], pr.dir)
    const other = await commit(pr.dir, "o.ts", "export function other() {}\n", "other")
    await git(["checkout", "-q", "--detach", "other"], pr.dir)
    await git(["merge", "-q", "--no-ff", "--no-edit", "feature"], pr.dir)
    const elsewhere = await revParse(pr.dir, "HEAD")

    const result = await run(pr.dir, event(pr))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toContain(
      `The checkout is ${elsewhere}, the pull request's head merged into ${other}, which is not on origin/main`,
    )
  })

  it("refuses a merge of some other commit, such as the merge ref of an earlier push", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "feature"], pr.dir)
    const pushedAgain = await commit(pr.dir, "c.ts", "export function later() {}\n", "again")
    await git(["checkout", "-q", "--detach", pr.merge], pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: pushedAgain })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toContain(
      `The checkout is ${pr.merge}: neither the pull request's head ${pushedAgain} nor a merge of it`,
    )
    expect(result.stderr).toContain("set the 'refspec' input to name both sides")
    expect(result.stderr).not.toContain("Under pull_request_target")
  })
})

describe("resolve-refspec.mjs, on the pull request's head", () => {
  it.each([
    ["the commit it branched from", "recordedBase"],
    ["the base branch's tip", "baseTip"],
  ] as const)("compares it with its merge base when base.sha is %s", async (_, recorded) => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: pr[recorded] })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("A\tb.ts")
  })

  it("compares a head that merged its base branch with the base commit it merged", async () => {
    // The pull request merges the base branch after the event recorded base.sha, and the base
    // branch moves on again: only the tracking ref finds the commit the pull request merged.
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "feature"], pr.dir)
    await git(["merge", "-q", "--no-edit", "main"], pr.dir)
    const head = await commit(pr.dir, "c.ts", "export function later() {}\n", "after main")
    await git(["checkout", "-q", "main"], pr.dir)
    const newer = await commit(pr.dir, "d.ts", "export function newer() {}\n", "main again")
    await setTrackingRef(pr.dir, newer)
    // An Actions clone has no local main at all; a stale one must not stand in for origin/main.
    await git(["checkout", "-q", "--detach", head], pr.dir)
    await git(["branch", "-f", "main", pr.recordedBase], pr.dir)

    const result = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: head })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.baseTip}..${head}`)
    expect(result.stderr).toContain(`merge base with origin/main, ${pr.baseTip}.`)
    expect(await changedPaths(pr.dir, pr.baseTip)).toBe("A\tb.ts\nA\tc.ts")

    // Without the tracking ref, base.sha is all there is, and the base branch's deletion is in
    // the comparison: the run goes on, and says so where the Checks UI shows it.
    await dropTrackingRef(pr.dir)
    const recordedOnly = await run(pr.dir, { ...event(pr), PR_HEAD_SHA: head })
    expect(recordedOnly.status).toBe(0)
    expect(recordedOnly.stdout).toBe(`${pr.recordedBase}..${head}`)
    expect(recordedOnly.stderr).toMatch(/^::warning::origin\/main is not in this clone/m)
    expect(recordedOnly.stderr).toContain("reported as the pull request's own")
    expect(recordedOnly.stderr).toContain(`merge base with base.sha, ${pr.recordedBase}.`)
    expect(await changedPaths(pr.dir, pr.recordedBase)).toBe("M\ta.ts\nA\tb.ts\nA\tc.ts")
  })

  it("keeps base.sha's merge base when the base branch was rewritten past it", async () => {
    const dir = join(scratch.root, "rewritten")
    await initRepository(dir)
    const root = await commit(dir, "r.ts", "export function root() {}\n", "root")
    const recorded = await commit(dir, "a.ts", "export function a() {}\n", "a")
    await git(["checkout", "-q", "-b", "feature"], dir)
    const head = await commit(dir, "b.ts", "export function b() {}\n", "b")
    await git(["checkout", "-q", "main"], dir)
    await git(["reset", "-q", "--hard", root], dir)
    await setTrackingRef(dir, await commit(dir, "z.ts", "export function z() {}\n", "rewritten"))
    await git(["checkout", "-q", "--detach", head], dir)

    const result = await run(dir, {
      EVENT_NAME: "pull_request",
      PR_BASE_SHA: recorded,
      PR_HEAD_SHA: head,
      PR_BASE_REF: "main",
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${recorded}..${head}`)
    expect(result.stderr).toContain(
      `merge base with base.sha, ${recorded}, which origin/main does not contain.`,
    )
    expect(await changedPaths(dir, recorded)).toBe("A\tb.ts")
  })

  it("finds the merge base from the tracking ref alone when base.sha is not in the clone", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: MISSING_SHA })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pr.recordedBase}..${pr.head}`)
    expect(result.stderr).toContain(`merge base with origin/main, ${pr.recordedBase}.`)
  })

  it("stops on a tracking ref that is there but cannot be read", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    await writeFile(join(pr.dir, ".git", "refs", "remotes", "origin", "main"), `${MISSING_SHA}\n`)
    const result = await run(pr.dir, event(pr))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toContain(
      "git show-ref --verify --quiet refs/remotes/origin/main failed",
    )
    expect(result.stderr).not.toContain("::warning::")
  })

  it("refuses a head when neither a tracking ref nor base.sha is in the clone", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    await dropTrackingRef(pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: MISSING_SHA })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toContain(
      `Neither origin/main nor base.sha ${MISSING_SHA} is in this clone`,
    )
  })

  it("names only what it compared when the head shares no history with it", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "--orphan", "unrelated"], pr.dir)
    await setTrackingRef(pr.dir, await commit(pr.dir, "u.ts", "export const u = 1\n", "unrelated"))
    await git(["checkout", "-q", "--detach", pr.head], pr.dir)
    const result = await run(pr.dir, { ...event(pr), PR_BASE_SHA: MISSING_SHA })
    expect(result.status).toBe(2)
    expect(errorLine(result)).toBe(
      `::error::git found no merge base of the pull request's head ${pr.head} with origin/main in this clone.`,
    )
  })
})

describe("resolve-refspec.mjs, on any other checkout", () => {
  it("refuses the base branch, which is what a pull_request_target checks out by default", async () => {
    const pr = await pullRequestBehindItsBase()
    await git(["checkout", "-q", "main"], pr.dir)
    const result = await run(pr.dir, event(pr, "pull_request_target"))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    const error = errorLine(result)
    expect(error).toContain(
      `The checkout is ${pr.baseTip}, a commit on the pull request's base branch main`,
    )
    expect(error).toContain("Under pull_request_target, actions/checkout checks out the base")
    expect(error).toContain("Check out the pull request's head or merge ref.")
    expect(error).not.toContain("refspec")
    expect(error).not.toContain("shallow")
  })

  it.each([
    [
      "merge ref",
      "pull-merge",
      (pr: PullRequest) =>
        `The checkout is ${pr.merge}, the pull request's head merged into ${pr.baseTip}.`,
    ],
    ["head", "feature", (pr: PullRequest) => `The checkout is the pull request's head ${pr.head}.`],
  ])("says what a shallow clone of the %s is, then that it is shallow", async (_, branch, lead) => {
    const pr = await pullRequestBehindItsBase()
    await git(["branch", "pull-merge", pr.merge], pr.dir)
    // A file URL, because a local path clone ignores `--depth`.
    await git(
      ["clone", "-q", "--depth", "1", "--branch", branch, pathToFileURL(pr.dir).href, "clone"],
      scratch.root,
    )
    const result = await run(join(scratch.root, "clone"), event(pr))
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toBe(
      `::error::${lead(pr)} This clone is shallow, which aburi diff refuses; check out with fetch-depth: 0.`,
    )
  })

  it("refuses a working directory that is not a checkout", async () => {
    const pr = await pullRequestBehindItsBase()
    const elsewhere = await notACheckout()
    const result = await run(elsewhere.dir, { ...event(pr), ...elsewhere.env })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`Could not read the checked-out commit in ${elsewhere.dir}`)
  })
})

describe("resolve-refspec.mjs, on its inputs", () => {
  it("passes an explicit refspec through, trimmed, without reading the checkout or the event", async () => {
    // Not a repository, and not a pull request: reaching either check would be an error.
    const elsewhere = await notACheckout()
    const result = await run(elsewhere.dir, {
      INPUT_REFSPEC: "  origin/main..HEAD \n",
      EVENT_NAME: "push",
      ...elsewhere.env,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("origin/main..HEAD")
    expect(result.stderr).toBe("")
  })

  it("refuses a refspec input of more than one line, which would add lines to the step's output", async () => {
    const result = await run(scratch.root, { INPUT_REFSPEC: "main..HEAD\nvalue=a..b" })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(errorLine(result)).toContain("The 'refspec' input spans more than one line")
  })

  it.each([
    ["empty", ""],
    ["blank", " \t "],
  ])("refuses an event that carries no pull request when refspec is %s", async (_, refspec) => {
    const result = await run(scratch.root, { INPUT_REFSPEC: refspec, EVENT_NAME: "push" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("No 'refspec' input and event 'push' does not carry a PR")
  })

  it.each([
    ["PR_BASE_SHA", "", "no base.sha"],
    ["PR_HEAD_SHA", "", "no head.sha"],
    ["PR_BASE_REF", "", "no base.ref"],
    ["PR_BASE_SHA", "abc1234", "base.sha 'abc1234' is not a full commit SHA"],
    ["PR_HEAD_SHA", "100%", "head.sha '100%25' is not a full commit SHA"],
  ])("refuses a pull request event whose %s is '%s' as malformed", async (field, value, says) => {
    const result = await run(scratch.root, {
      EVENT_NAME: "pull_request",
      PR_BASE_SHA: MISSING_SHA,
      PR_HEAD_SHA: MISSING_SHA,
      PR_BASE_REF: "main",
      [field]: value,
    })
    expect(result.status).toBe(2)
    expect(errorLine(result)).toBe(
      `::error::The pull_request event's payload is malformed (${says}); refusing to guess the pull request's refs.`,
    )
  })
})
