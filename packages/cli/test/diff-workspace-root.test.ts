import { spawn } from "node:child_process"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"

/**
 * A ref diff checks the base revision out as a worktree of the repository and scans the head in
 * the caller's directory, so both sides have to root at that repository. The head used to climb
 * to the outermost workspace marker, past the repository's own `.git`, and the base scan's
 * re-detection climbed out of the temporary worktree the same way. These are the three layouts
 * where something sits above the repository, run against real git.
 */

let scratch = ""
const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const
let savedTemp: Partial<Record<(typeof TEMP_VARIABLES)[number], string>> = {}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: resolve(scratch, "absent-gitconfig"),
        GIT_CONFIG_SYSTEM: resolve(scratch, "absent-gitconfig"),
        GIT_AUTHOR_NAME: "Aburi Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Aburi Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    })
    const err: Buffer[] = []
    const out: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"))
      else rejectPromise(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err)}`))
    })
  })
}

/** A one-commit repository with one function, ignoring what the layouts below put inside it. */
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

/** Commit one more function, so the head adds exactly one Symbol. */
async function addFunction(directory: string, file: string, name: string): Promise<void> {
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", `add ${name}`], directory)
}

function diffIn(cwd: string, refSpec: string, failOn: string): ReturnType<typeof runDiff> {
  return runDiff({ cwd, refSpec, outputDir: resolve(cwd, "out"), failOn, warn: () => {} })
}

beforeEach(async () => {
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

    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 ↔0 /)
    expect(result.exitCode).toBe(EXIT.GATE)
  })

  it("diffs a repository nested in another without reading every Symbol as moved", async () => {
    const outer = resolve(scratch, "outer")
    await mkdir(outer)
    await git(["init", "-q", "-b", "main"], outer)
    const inner = resolve(outer, "demo")
    await repository(inner)
    await addFunction(inner, "src/one.ts", "two")

    const result = await diffIn(inner, "HEAD~1..HEAD", "moved")

    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 ↔0 /)
    expect(result.exitCode).toBe(EXIT.SUCCESS)
  })

  it("scans the base revision when the temporary directory is inside the repository", async () => {
    const demo = resolve(scratch, "demo")
    await repository(demo)
    await addFunction(demo, "src/one.ts", "two")
    const inside = resolve(demo, ".tmp")
    await mkdir(inside)
    for (const name of TEMP_VARIABLES) process.env[name] = inside

    const result = await diffIn(demo, "HEAD~1..HEAD", "added")

    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 ↔0 /)
  })
})
