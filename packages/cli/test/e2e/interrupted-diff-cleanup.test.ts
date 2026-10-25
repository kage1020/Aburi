import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gitTestEnv } from "@aburi/test-support"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CLI_BIN, linkedWorktrees, removeWorktreeTempDirs, useBuiltBin } from "./bin"

const STALLING_PLUGIN = `
import { writeFileSync } from "node:fs"
writeFileSync(process.env.ABURI_TEST_READY_FILE, "waiting")
await new Promise(() => setInterval(() => {}, 1000))
`

let repo = ""
let decoy = ""
let child: ChildProcess | null = null

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitTestEnv(repo) })
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

beforeEach(async () => {
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
  await removeWorktreeTempDirs(repo)
  await rm(repo, { recursive: true, force: true })
  await rm(decoy, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("aburi diff, interrupted in the base scan", () => {
  useBuiltBin()

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
    const running = spawn(process.execPath, [CLI_BIN, "diff", "HEAD~1..HEAD"], {
      cwd: repo,
      env: gitTestEnv(repo, {
        ABURI_TEST_READY_FILE: ready,
        ...(decoyEnv ? { GIT_INDEX_FILE: decoyIndex, GIT_PREFIX: "src/" } : {}),
      }),
      stdio: "ignore",
    })
    child = running
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      running.on("exit", (code, signalCode) => done({ code, signal: signalCode })),
    )

    await until(() => existsSync(ready), "the base scan to reach the stalling plugin")
    const [worktree] = linkedWorktrees(repo)
    expect(worktree, "the run should be holding a base worktree").toBeDefined()
    const checkoutParent = dirname(dirname(worktree as string))
    expect(existsSync(checkoutParent)).toBe(true)

    running.kill(signal)
    const outcome = await exited

    // Re-raised rather than swallowed: the shell sees 128+N, as without the listener.
    expect(outcome).toEqual({ code: null, signal })
    expect(linkedWorktrees(repo)).toEqual([])
    expect(existsSync(checkoutParent)).toBe(false)
    expect(await readFile(decoyIndex)).toEqual(decoyIndexBefore)
  }, 30_000)
})
