import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, type GitRunner, runDiff } from "../src"

/**
 * Ref-spec parsing (`cli-spec.md` §6.3). Every case here is decided before git is touched,
 * so the injected runner exists only to make a pass through it loud: any spec that reaches
 * `rev-parse` was accepted, and these specs must not be.
 *
 * `parseFailure` asserts the `input-error` code rather than `CliError` alone, because
 * `assertRefResolvable` wraps a runner's own throw into a `CliError` too — a `runtime-error`
 * one. Without the code, a spec that reached git would satisfy the guard this file is built on.
 */

let scratch = ""

const refusingGit: GitRunner = {
  async run(args) {
    throw new Error(`git must not run for a rejected ref spec (got: git ${args.join(" ")})`)
  },
}

async function parseFailure(refSpec: string): Promise<CliError> {
  const error = await runDiff({
    cwd: scratch,
    refSpec,
    git: refusingGit,
    outputDir: resolve(scratch, "out"),
    warn: () => {},
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(CliError)
  expect((error as CliError).code).toBe("input-error")
  return error as CliError
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-refspec-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff ref spec — three-dot form", () => {
  it("rejects main...HEAD instead of running with '.HEAD' as the head ref", async () => {
    const error = await parseFailure("main...HEAD")
    // Branch-specific, both of them. The generic message carries `e.g. main..HEAD` of its
    // own, so asserting the rewrite alone would still pass with the three-dot branch deleted.
    expect(error.message).toContain("uses the three-dot form")
    expect(error.message).toContain('write it as "main..HEAD"')
  })

  it("classifies it as an input error (exit 2, §6.5), not a runtime git failure", async () => {
    // The code is what `parseFailure` guards; this case is where the rule is written down.
    const error = await parseFailure("main...HEAD")
    expect(error.code).toBe("input-error")
  })

  it("names the two-dot rewrite from the caller's own refs", async () => {
    // A dotted tag cannot collide with the generic message's `main..HEAD` example, so this
    // is the case that pins the rewrite to the refs that were actually typed.
    const error = await parseFailure("v1.2.0...v1.3.0")
    expect(error.message).toContain('write it as "v1.2.0..v1.3.0"')
  })

  it("points at git merge-base with placeholders, not with the refs pasted into a command", async () => {
    // `$ ( ) " ; & |` and backticks all pass `git check-ref-format`, so a copy-pasteable
    // command built from a ref name hands the reader a substitution to run.
    const error = await parseFailure("feature/$(id)...HEAD")
    expect(error.message).toContain("git merge-base <base> <head>")
    expect(error.message).not.toContain("$(git merge-base")
  })
})

describe("runDiff ref spec — two-dot form is unaffected", () => {
  it("keeps refs that contain dots of their own whole, on both sides", async () => {
    // Reaching git is the assertion: the spec parsed, and both refs are verified before the
    // runner fails at the worktree, so the head — the slice taken after the dot run — is
    // covered as well as the base.
    const seen: string[] = []
    const recordingGit: GitRunner = {
      async run(args) {
        seen.push(args.join(" "))
        if (args[0] === "worktree") throw new Error("worktree add refused")
        if (args[1] === "--is-shallow-repository") return { stdout: "false\n", stderr: "" }
        return { stdout: "abc\n", stderr: "" }
      },
    }
    await expect(
      runDiff({
        cwd: scratch,
        refSpec: "v1.2.0..v1.3.0",
        git: recordingGit,
        outputDir: resolve(scratch, "out"),
        warn: () => {},
      }),
    ).rejects.toThrow()
    // `toContain` rather than an index: the order of the preflight calls is
    // `assertRefResolvable`'s contract, not this file's.
    expect(seen).toContain("rev-parse --verify v1.2.0")
    expect(seen).toContain("rev-parse --verify v1.3.0")
  })
})

describe("runDiff ref spec — other malformed specs", () => {
  it("rejects a spec with no separator", async () => {
    const error = await parseFailure("main")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects a spec with more than one separator", async () => {
    const error = await parseFailure("a..b..c")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects a three-dot run followed by a second separator", async () => {
    // The ordering case. Judged as three-dot first, `a...b..c` would be answered with the
    // rewrite `a..b..c`, which this same function rejects, and with `b..c` named as a ref.
    const error = await parseFailure("a...b..c")
    expect(error.message).toContain("is not a valid ref spec")
    expect(error.message).not.toContain("three-dot")
  })

  it("rejects a dot run longer than three", async () => {
    const error = await parseFailure("main....HEAD")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects an empty side rather than reading it as a three-dot spec", async () => {
    const error = await parseFailure("main...")
    expect(error.message).toContain("non-empty base and head refs")
  })
})
