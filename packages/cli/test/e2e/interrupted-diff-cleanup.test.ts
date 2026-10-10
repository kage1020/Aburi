import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
const CLI_ENTRY = fileURLToPath(new URL("../../src/bin/aburi.ts", import.meta.url))

const STALLING_PLUGIN = `
import { writeFileSync } from "node:fs"
writeFileSync(process.env.ABURI_TEST_READY_FILE, "waiting")
await new Promise(() => setInterval(() => {}, 1000))
`

let repo = ""
let decoy = ""
let child: ChildProcess | null = null
/** The `aburi-worktree-*` temp directories that existed before the test started. */
let tempDirsBefore = new Set<string>()

function pinnedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(repo, "absent-gitconfig"),
    GIT_CONFIG_SYSTEM: join(repo, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "Aburi Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Aburi Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  // A run started from a commit hook carries these; the fixture must not be built through them.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"])
    delete env[name]
  return env
}

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: pinnedGitEnv() })
}

async function worktreeTempDirs(): Promise<string[]> {
  const names = await readdir(tmpdir())
  return names
    .filter((name) => name.startsWith("aburi-worktree-"))
    .map((name) => join(tmpdir(), name))
}

/** The linked worktrees git has registered for `repo`, the main one excluded. */
function linkedWorktrees(): string[] {
  return git(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1)
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

beforeEach(async () => {
  tempDirsBefore = new Set(await worktreeTempDirs())
  repo = await realpath(await mkdtemp(join(tmpdir(), "aburi-interrupt-")))
  await mkdir(join(repo, "src"))
  await mkdir(join(repo, "plugins"))
  await writeFile(join(repo, "package.json"), '{"name":"demo","private":true}\n')
  await writeFile(
    join(repo, "aburi.json"),
    JSON.stringify({ languages: ["lang-typescript"], effects: ["./plugins/stall.mjs"] }),
  )
  await writeFile(join(repo, ".gitignore"), "out/\nready\n")
  await writeFile(join(repo, "plugins/stall.mjs"), STALLING_PLUGIN)
  await writeFile(join(repo, "src/a.ts"), "export function a(): number { return 1 }\n")
  git(["init", "-q", "-b", "main"])
  git(["add", "-A"])
  git(["commit", "-qm", "c1"])
  await writeFile(join(repo, "src/a.ts"), "export function a(): number { return 2 }\n")
  git(["commit", "-qam", "c2"])

  // Another repository, for the case that points a commit hook's variables at it.
  decoy = await realpath(await mkdtemp(join(tmpdir(), "aburi-interrupt-decoy-")))
  await writeFile(join(decoy, "x.txt"), "x\n")
  git(["init", "-q", "-b", "main"], decoy)
  git(["add", "-A"], decoy)
  git(["commit", "-qm", "decoy"], decoy)
})

afterEach(async () => {
  child?.kill("SIGKILL")
  child = null
  for (const dir of await worktreeTempDirs()) {
    if (tempDirsBefore.has(dir) || !existsSync(join(dir, "base", basename(repo)))) continue
    await rm(dir, { recursive: true, force: true })
  }
  await rm(repo, { recursive: true, force: true })
  await rm(decoy, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("aburi diff, interrupted in the base scan", () => {
  it.each([
    { signal: "SIGINT", decoyEnv: false },
    { signal: "SIGTERM", decoyEnv: false },
    { signal: "SIGHUP", decoyEnv: false },
    { signal: "SIGINT", decoyEnv: true },
  ] as const)("removes the worktree and its checkout on $signal (decoy git env: $decoyEnv), and still dies of the signal", async ({
    signal,
    decoyEnv,
  }) => {
    const ready = join(repo, "ready")
    const decoyIndex = join(decoy, ".git", "index")
    const decoyIndexBefore = await readFile(decoyIndex)
    const running = spawn(
      process.execPath,
      ["--import", TSX_LOADER, CLI_ENTRY, "diff", "HEAD~1..HEAD"],
      {
        cwd: repo,
        env: {
          ...pinnedGitEnv(),
          ABURI_TEST_READY_FILE: ready,
          ...(decoyEnv ? { GIT_INDEX_FILE: decoyIndex, GIT_PREFIX: "src/" } : {}),
        },
        stdio: "ignore",
      },
    )
    child = running
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      running.on("exit", (code, signalCode) => done({ code, signal: signalCode })),
    )

    await until(() => existsSync(ready), "the base scan to reach the stalling plugin")
    const [worktree] = linkedWorktrees()
    expect(worktree, "the run should be holding a base worktree").toBeDefined()
    const checkoutParent = dirname(dirname(worktree as string))
    expect(existsSync(checkoutParent)).toBe(true)

    running.kill(signal)
    const outcome = await exited

    // Re-raised rather than swallowed: the shell sees 128+N, as without the listener.
    expect(outcome).toEqual({ code: null, signal })
    expect(linkedWorktrees()).toEqual([])
    expect(existsSync(checkoutParent)).toBe(false)
    expect(await readFile(decoyIndex)).toEqual(decoyIndexBefore)
  }, 30_000)
})
