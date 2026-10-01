import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { gitChildEnv } from "../src/commands/diff"
import { realGit as git, probeRealGit } from "./fixtures"

/**
 * A ref diff run from a commit hook, against a real repository.
 *
 * git exports `GIT_INDEX_FILE` into a pre-commit hook, naming the index of the commit being
 * made. `git worktree add` checks the base out through whatever index that variable names, so
 * a diff that passed its environment on overwrote the index git was about to commit, and the
 * commit silently recorded the base revision's tree, whenever the path was absolute: `commit -a`
 * and `commit <paths>` export one in the main worktree, and every commit exports one in a linked
 * worktree. A plain `commit` in the main worktree exports the relative `.git/index`, on which the
 * worktree step failed instead. Only a real `git` shows either, so the injected runner the other
 * diff tests use cannot stand in here.
 */

/** Every variable a case here sets on `process.env`, restored after each case. */
const HOOK_ENV = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX"] as const

let scratch = ""
let savedEnv: Partial<Record<(typeof HOOK_ENV)[number], string>> = {}
let gitProbeError: unknown = null

/** Two commits in `directory`: the second adds `src/two.ts`, so base and head trees differ. */
async function commitTwice(directory: string, run: (args: string[]) => Promise<string>) {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(resolve(directory, "package.json"), '{"name":"demo","private":true}\n', "utf8")
  await writeFile(resolve(directory, "aburi.json"), '{"languages":["lang-typescript"]}\n', "utf8")
  await writeFile(resolve(directory, ".gitignore"), "out/\n", "utf8")
  await writeFile(
    resolve(directory, "src/one.ts"),
    "export function one(): number { return 1 }\n",
    "utf8",
  )
  await run(["add", "-A"])
  await run(["commit", "-q", "-m", "c1"])
  await writeFile(
    resolve(directory, "src/two.ts"),
    "export function two(): number { return 2 }\n",
    "utf8",
  )
  await run(["add", "-A"])
  await run(["commit", "-q", "-m", "c2"])
}

function diffFrom(cwd: string, refSpec = "HEAD~1..HEAD"): ReturnType<typeof runDiff> {
  return runDiff({ cwd, refSpec, outputDir: resolve(cwd, "out"), warn: () => {} })
}

/** What the index `indexFile` holds, read through git rather than byte for byte. */
function stagedIn(indexFile: string, cwd: string): Promise<string> {
  return git(["ls-files", "--stage"], cwd, { GIT_INDEX_FILE: indexFile })
}

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-hook-env-"))
  savedEnv = {}
  for (const name of HOOK_ENV) {
    const value = process.env[name]
    if (value !== undefined) savedEnv[name] = value
  }
})

afterEach(async () => {
  for (const name of HOOK_ENV) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

describe("the environment aburi diff spawns git with", () => {
  it("drops the hook's index and prefix and passes the repository and the caller's settings on", () => {
    const caller: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: "/repo/.git/index.lock",
      GIT_PREFIX: "",
      GIT_DIR: "/repo/.git/worktrees/feat",
      GIT_WORK_TREE: "/home/me",
      GIT_IMPLICIT_WORK_TREE: "0",
      GIT_COMMON_DIR: "/repo/.git",
      GIT_OBJECT_DIRECTORY: "/repo/.git/objects",
      GIT_CONFIG_PARAMETERS: "'diff.renamelimit'='0'",
      PATH: "/usr/bin",
    }
    const child = gitChildEnv(caller)
    expect(Object.keys(child).sort()).toEqual(
      [
        "GIT_COMMON_DIR",
        "GIT_CONFIG_PARAMETERS",
        "GIT_DIR",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_WORK_TREE",
        "PATH",
      ].sort(),
    )
    expect(child.GIT_DIR).toBe(caller.GIT_DIR)
    // A copy: the caller's own environment keeps what the child does not get.
    expect(caller.GIT_INDEX_FILE).toBe("/repo/.git/index.lock")
  })
})

describe("aburi diff inside a commit hook", () => {
  let repository = ""

  beforeEach(async () => {
    repository = resolve(scratch, "demo")
    await mkdir(repository)
    await git(["init", "-q", "-b", "main"], repository)
    await commitTwice(repository, (args) => git(args, repository))
  })

  it("leaves an absolute GIT_INDEX_FILE untouched, as the main worktree's `commit -a` exports it", async () => {
    // Stands in for both absolute shapes, `.git/index.lock` (`commit -a`) and
    // `.git/next-index-<pid>.lock` (`commit <paths>`). It is not named `index.lock` because a
    // real one is git's lock on the index, and the fixture's own git calls would refuse to run
    // ("Another git process seems to be running").
    const indexFile = resolve(repository, ".git/hook-index")
    await copyFile(resolve(repository, ".git/index"), indexFile)
    const before = await readFile(indexFile)
    const ownIndex = await readFile(resolve(repository, ".git/index"))
    process.env.GIT_INDEX_FILE = indexFile

    const result = await diffFrom(repository)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    // The diff itself still compares the two commits: `two()` is the one Symbol added.
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(indexFile)).equals(before)).toBe(true)
    // The index the commit is made from still stages the head's tree, not the base's.
    expect(await stagedIn(indexFile, repository)).toContain("src/two.ts")
    // And the repository's own index is untouched too.
    expect((await readFile(resolve(repository, ".git/index"))).equals(ownIndex)).toBe(true)
  })

  it("runs with the relative `.git/index` a plain `commit` exports in the main worktree", async () => {
    const index = resolve(repository, ".git/index")
    const before = await readFile(index)
    process.env.GIT_INDEX_FILE = ".git/index"
    process.env.GIT_PREFIX = ""

    const result = await diffFrom(repository)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(index)).equals(before)).toBe(true)
  })

  it("leaves a linked worktree's index untouched, where every commit exports an absolute one", async () => {
    const linked = resolve(scratch, "linked")
    await git(["worktree", "add", "-q", "-b", "feat", linked, "HEAD"], repository)
    // What git exports into a hook run inside a linked worktree, whatever the commit's shape.
    const gitDir = resolve(repository, ".git/worktrees/linked")
    const indexFile = resolve(gitDir, "index")
    const before = await readFile(indexFile)
    process.env.GIT_DIR = gitDir
    process.env.GIT_INDEX_FILE = indexFile

    const result = await diffFrom(linked)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(indexFile)).equals(before)).toBe(true)
    expect(await stagedIn(indexFile, linked)).toContain("src/two.ts")
  })
})

/**
 * A bare repository driven with `GIT_DIR` and `GIT_WORK_TREE`, the dotfiles arrangement: no
 * `.git` stands at or above the work tree, so the environment is all that names the repository.
 */
describe("aburi diff on a repository only the environment names", () => {
  let workTree = ""

  beforeEach(async () => {
    const gitDir = resolve(scratch, "dotfiles.git")
    workTree = resolve(scratch, "home")
    await mkdir(workTree)
    await git(["init", "-q", "--bare", "-b", "main", gitDir], scratch)
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: workTree }
    await commitTwice(workTree, (args) => git(args, workTree, env))
    process.env.GIT_DIR = gitDir
    process.env.GIT_WORK_TREE = workTree
  })

  it("compares its revisions, which only GIT_DIR can find", async () => {
    const result = await diffFrom(workTree)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
  })

  it("diagnoses a mistyped ref as one, which takes GIT_WORK_TREE to see the work tree", async () => {
    await expect(diffFrom(workTree, "nosuchref..HEAD")).rejects.toThrow(
      "no such revision in this repository",
    )
  })
})
