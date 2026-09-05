import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, type GitRunner, runDiff } from "../src"

/**
 * Ref-spec parsing (`cli-spec.md` §6.3). Every case here is decided before git is touched,
 * so the injected runner exists only to make a pass through it loud: any spec that reaches
 * `rev-parse` was accepted, and these specs must not be.
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
    // The defect this covers: splitting on every ".." made the head ".HEAD", which passed
    // the syntax check and failed later as an unresolvable ref the user never typed.
    expect(error.message).not.toContain(".HEAD'")
    expect(error.message).toContain("main..HEAD")
  })

  it("classifies it as an input error (exit 2, §6.5), not a runtime git failure", async () => {
    const error = await parseFailure("main...HEAD")
    expect(error.code).toBe("input-error")
  })

  it("names both sides so the two-dot form can be copied out of the message", async () => {
    const error = await parseFailure("v1.2.0...v1.3.0")
    expect(error.message).toContain("v1.2.0..v1.3.0")
    expect(error.message).toContain("git merge-base v1.2.0 v1.3.0")
  })
})

describe("runDiff ref spec — two-dot form is unaffected", () => {
  it("keeps a base ref that contains dots whole", async () => {
    // Reaching git at all is the assertion: the spec parsed, and the refusing runner
    // reports the ref pair it was asked about.
    const seen: string[] = []
    const recordingGit: GitRunner = {
      async run(args) {
        seen.push(args.join(" "))
        throw Object.assign(new Error("unknown revision"), { code: 128 })
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
    ).rejects.toBeInstanceOf(CliError)
    expect(seen[0]).toBe("rev-parse --verify v1.2.0")
  })
})

describe("runDiff ref spec — other malformed specs", () => {
  it("rejects a spec with no separator", async () => {
    const error = await parseFailure("main")
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects a spec with more than one separator", async () => {
    const error = await parseFailure("a..b..c")
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects a dot run longer than three", async () => {
    const error = await parseFailure("main....HEAD")
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("is not a valid ref spec")
  })

  it("rejects an empty side rather than reading it as a three-dot spec", async () => {
    const error = await parseFailure("main...")
    expect(error.code).toBe("input-error")
    expect(error.message).toContain("non-empty base and head refs")
  })
})
