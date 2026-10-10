import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, type GitRunner, runDiff } from "../src"

let scratch = ""

let gitCalls: string[] = []

const refusingGit: GitRunner = {
  async run(args) {
    gitCalls.push(args.join(" "))
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
  expect(gitCalls).toEqual([])
  return error as CliError
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-refspec-"))
  gitCalls = []
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff ref spec — three-dot form", () => {
  it("rejects main...HEAD instead of running with '.HEAD' as the head ref", async () => {
    const error = await parseFailure("main...HEAD")
    expect(error.message).toContain("uses the three-dot form")
    expect(error.message).toContain('write it as "main..HEAD"')
  })

  it("classifies it as an input error (exit 2), not a runtime git failure", async () => {
    const error = await parseFailure("main...HEAD")
    expect(error.code).toBe("input-error")
  })

  it("names the two-dot rewrite from the caller's own refs", async () => {
    const error = await parseFailure("v1.2.0...v1.3.0")
    expect(error.message).toContain('write it as "v1.2.0..v1.3.0"')
  })

  it("points at git merge-base with placeholders, not with the refs pasted into a command", async () => {
    const error = await parseFailure("feature/$(id)...HEAD")
    expect(error.message).toContain("git merge-base <base> <head>")
    expect(error.message).not.toContain("$(git merge-base")
  })
})

describe("runDiff ref spec — two-dot form is unaffected", () => {
  it("keeps refs that contain dots of their own whole, on both sides", async () => {
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
    expect(seen).toContain("rev-parse --verify v1.2.0")
    expect(seen).toContain("rev-parse --verify v1.3.0")
  })
})

describe("runDiff ref spec — other malformed specs", () => {
  it.each([
    ["no separator", "main"],
    ["more than one separator", "a..b..c"],
    ["a dot run longer than three", "main....HEAD"],
  ])("rejects a spec with %s", async (_, spec) => {
    const error = await parseFailure(spec)
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects a three-dot run followed by a second separator", async () => {
    const error = await parseFailure("a...b..c")
    expect(error.message).toContain("is not a valid ref spec")
    expect(error.message).not.toContain("three-dot")
  })

  it("rejects an empty side rather than reading it as a three-dot spec", async () => {
    const error = await parseFailure("main...")
    expect(error.message).toContain("non-empty base and head refs")
  })
})
