import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Interrupting `aburi diff` must not leave its base worktree behind.
 *
 * Node's default action for SIGINT / SIGTERM / SIGHUP ends the process without running the
 * `finally` that removes the worktree, so every Ctrl-C or cancelled CI job left a registered
 * `(detached HEAD)` worktree in the user's repository and a full base checkout under the temp
 * directory. Only a real process and a real signal show this: the CLI is spawned from its built
 * bin, held in the base scan by a plugin whose module never finishes loading, and signalled once that
 * plugin says it is waiting.
 *
 * Skipped on Windows because this harness cannot send a signal there: `child.kill()` is
 * `TerminateProcess`, which no listener can observe. Windows itself does deliver a catchable
 * `SIGINT` for an interactive Ctrl-C and a `SIGHUP` when the console window closes, so the
 * listener does run there; it is this test that cannot reach it.
 */

const require = createRequire(import.meta.url)
const CLI_BIN = resolve(dirname(require.resolve("@aburi/cli/package.json")), "dist/bin/aburi.mjs")

/**
 * An effects plugin whose module never finishes loading: it announces itself through a file,
 * then awaits forever at the top level, with a timer keeping the event loop alive (an unsettled
 * promise alone would let the process exit 0). Asynchronously, so the loop stays free to deliver
 * the signal, which a synchronous stall inside `classify` would not. It exports nothing:
 * evaluation never gets past the await, and the loader only `import()`s the module, so no plugin
 * shape would ever be read.
 */
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

/**
 * Pinned so a developer's own config (`commit.gpgsign`, `core.hooksPath`) cannot change what the
 * test's git calls or the CLI's do, and with the identity a commit needs. Applied to both.
 */
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
  // A failing case leaves the run's temp directory behind. Only one this test can attribute to
  // itself is removed: new since it started, and holding a checkout named after this repository
  // (the base worktree's leaf is the head workspace's directory name). Other test files may be
  // running `aburi diff` at the same time.
  for (const dir of await worktreeTempDirs()) {
    if (tempDirsBefore.has(dir) || !existsSync(join(dir, "base", basename(repo)))) continue
    await rm(dir, { recursive: true, force: true })
  }
  await rm(repo, { recursive: true, force: true })
  await rm(decoy, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("aburi diff, interrupted in the base scan", () => {
  // The decoy case: a commit hook's `GIT_INDEX_FILE` / `GIT_PREFIX` pointing into another
  // repository must neither stop the interrupted run from cleaning up nor touch that repository's
  // index. It catches an unscrubbed `worktree add`, which checks the base out through the index
  // it is given. It does not pin the scrub on the signal path's own `worktree remove --force`,
  // which reads no index: that call cleans up with or without it. (`GIT_DIR` is not decoyed: the
  // run passes it on deliberately, as the repository it is about.)
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
      env: {
        ...pinnedGitEnv(),
        ABURI_TEST_READY_FILE: ready,
        ...(decoyEnv ? { GIT_INDEX_FILE: decoyIndex, GIT_PREFIX: "src/" } : {}),
      },
      stdio: "ignore",
    })
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
