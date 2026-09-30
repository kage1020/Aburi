import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"

/**
 * A ref diff run from a commit hook, against a real repository.
 *
 * git exports `GIT_INDEX_FILE` into a pre-commit hook, naming the index of the commit being
 * made. `git worktree add` checks the base out through whatever index that variable names, so
 * a diff that passed its environment on overwrote the index git was about to commit (the
 * absolute path `commit -a` and `commit <paths>` export: the commit silently records the base
 * revision's tree) or failed on the new worktree's `.git` file (the relative `.git/index` a
 * plain `commit` exports). Only a real `git` shows either, so the injected runner the other
 * diff tests use cannot stand in here.
 */

let scratch = ""
let savedIndexFile: string | undefined

/** The fixture's own git calls: the developer's config must not decide what they do. */
function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: resolve(cwd, "absent-gitconfig"),
      GIT_CONFIG_SYSTEM: resolve(cwd, "absent-gitconfig"),
      GIT_AUTHOR_NAME: "Aburi Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Aburi Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    }
    delete env.GIT_INDEX_FILE
    const child = spawn("git", args, { cwd, env })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"))
      else
        rejectPromise(
          new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`),
        )
    })
  })
}

/** Two commits: the second adds `src/two.ts`, so the base tree and the head tree differ. */
async function twoCommitRepository(directory: string): Promise<void> {
  await git(["init", "-q", "-b", "main"], directory)
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(resolve(directory, "package.json"), '{"name":"demo","private":true}\n', "utf8")
  await writeFile(resolve(directory, "aburi.json"), '{"languages":["lang-typescript"]}\n', "utf8")
  await writeFile(resolve(directory, ".gitignore"), "out/\n", "utf8")
  await writeFile(
    resolve(directory, "src/one.ts"),
    "export function one(): number { return 1 }\n",
    "utf8",
  )
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "c1"], directory)
  await writeFile(
    resolve(directory, "src/two.ts"),
    "export function two(): number { return 2 }\n",
    "utf8",
  )
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "c2"], directory)
}

function diffFromHook(cwd: string): ReturnType<typeof runDiff> {
  return runDiff({
    cwd,
    refSpec: "HEAD~1..HEAD",
    outputDir: resolve(cwd, "out"),
    warn: () => {},
  })
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-hook-env-"))
  savedIndexFile = process.env.GIT_INDEX_FILE
})

afterEach(async () => {
  if (savedIndexFile === undefined) delete process.env.GIT_INDEX_FILE
  else process.env.GIT_INDEX_FILE = savedIndexFile
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff inside a commit hook", () => {
  it("leaves an absolute GIT_INDEX_FILE untouched, as `commit -a` exports it", async () => {
    const repository = resolve(scratch, "demo")
    await mkdir(repository)
    await twoCommitRepository(repository)
    // A copy stands in for `.git/index.lock`: a separate file the base tree could land in.
    const indexFile = resolve(repository, ".git/next-index.lock")
    await copyFile(resolve(repository, ".git/index"), indexFile)
    const before = await readFile(indexFile)
    process.env.GIT_INDEX_FILE = indexFile

    const result = await diffFromHook(repository)
    expect(result.exitCode).toBe(EXIT.SUCCESS)
    // The diff itself still compares the two commits: `two()` is the one Symbol added.
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(indexFile)).equals(before)).toBe(true)
    // The head still has `src/two.ts` in the index the commit is made from.
    delete process.env.GIT_INDEX_FILE
    const staged = await git(["ls-files", "--stage"], repository)
    expect(staged).toContain("src/two.ts")
  })

  it("runs with the relative `.git/index` a plain `commit` exports", async () => {
    const repository = resolve(scratch, "demo")
    await mkdir(repository)
    await twoCommitRepository(repository)
    const index = resolve(repository, ".git/index")
    const before = await readFile(index)
    process.env.GIT_INDEX_FILE = ".git/index"

    expect((await diffFromHook(repository)).exitCode).toBe(EXIT.SUCCESS)
    expect((await readFile(index)).equals(before)).toBe(true)
  })
})
