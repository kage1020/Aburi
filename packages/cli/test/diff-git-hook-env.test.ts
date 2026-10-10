import { copyFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EXIT, runDiff } from "../src"
import { gitChildEnv } from "../src/git/runner"
import { git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-hook-env")

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Two commits, the second adding `two()`, made through `run` so the caller picks the repository. */
async function commitTwice(directory: string, run: (args: string[]) => Promise<string>) {
  await writePackageJson(directory, { name: "demo", private: true })
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, ".gitignore", "out/\n")
  await writeFileAt(directory, "src/one.ts", "export function one(): number { return 1 }\n")
  await run(["add", "-A"])
  await run(["commit", "-q", "-m", "c1"])
  await writeFileAt(directory, "src/two.ts", "export function two(): number { return 2 }\n")
  await run(["add", "-A"])
  await run(["commit", "-q", "-m", "c2"])
}

function diffFrom(cwd: string, refSpec = "HEAD~1..HEAD"): ReturnType<typeof runDiff> {
  return runDiff({ cwd, refSpec, outputDir: resolve(cwd, "out"), warn: () => {} })
}

function stagedIn(indexFile: string, cwd: string): Promise<string> {
  return git(["ls-files", "--stage"], cwd, { GIT_INDEX_FILE: indexFile })
}

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
    expect(Object.keys(child).sort()).toEqual([
      "GIT_COMMON_DIR",
      "GIT_CONFIG_PARAMETERS",
      "GIT_DIR",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_WORK_TREE",
      "PATH",
    ])
    expect(child.GIT_DIR).toBe(caller.GIT_DIR)
    expect(caller.GIT_INDEX_FILE).toBe("/repo/.git/index.lock")
  })
})

describe("aburi diff inside a commit hook", () => {
  let repository = ""

  beforeEach(async () => {
    repository = resolve(workspace.root, "demo")
    await initRepository(repository)
    await commitTwice(repository, (args) => git(args, repository))
  })

  it("leaves an absolute GIT_INDEX_FILE untouched, as the main worktree's `commit -a` exports it", async () => {
    const indexFile = resolve(repository, ".git/hook-index")
    await copyFile(resolve(repository, ".git/index"), indexFile)
    const before = await readFile(indexFile)
    const ownIndex = await readFile(resolve(repository, ".git/index"))
    vi.stubEnv("GIT_INDEX_FILE", indexFile)

    const result = await diffFrom(repository)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(indexFile)).equals(before)).toBe(true)
    expect(await stagedIn(indexFile, repository)).toContain("src/two.ts")
    expect((await readFile(resolve(repository, ".git/index"))).equals(ownIndex)).toBe(true)
  })

  it("runs with the relative `.git/index` a plain `commit` exports in the main worktree", async () => {
    const index = resolve(repository, ".git/index")
    const before = await readFile(index)
    vi.stubEnv("GIT_INDEX_FILE", ".git/index")
    vi.stubEnv("GIT_PREFIX", "")

    const result = await diffFrom(repository)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(index)).equals(before)).toBe(true)
  })

  it("leaves a linked worktree's index untouched, where every commit exports an absolute one", async () => {
    const linked = resolve(workspace.root, "linked")
    await git(["worktree", "add", "-q", "-b", "feat", linked, "HEAD"], repository)
    const gitDir = resolve(repository, ".git/worktrees/linked")
    const indexFile = resolve(gitDir, "index")
    const before = await readFile(indexFile)
    vi.stubEnv("GIT_DIR", gitDir)
    vi.stubEnv("GIT_INDEX_FILE", indexFile)

    const result = await diffFrom(linked)

    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.summaryLine).toMatch(/^\+1 -0 ~0 /)
    expect((await readFile(indexFile)).equals(before)).toBe(true)
    expect(await stagedIn(indexFile, linked)).toContain("src/two.ts")
  })
})

describe("aburi diff on a repository only the environment names", () => {
  let workTree = ""

  beforeEach(async () => {
    const gitDir = resolve(workspace.root, "dotfiles.git")
    workTree = resolve(workspace.root, "home")
    await git(["init", "-q", "--bare", "-b", "main", gitDir], workspace.root)
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: workTree }
    await commitTwice(workTree, (args) => git(args, workTree, env))
    vi.stubEnv("GIT_DIR", gitDir)
    vi.stubEnv("GIT_WORK_TREE", workTree)
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
