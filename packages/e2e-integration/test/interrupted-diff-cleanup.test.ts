import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
 * POSIX only: Windows has no way to deliver SIGINT or SIGTERM to another process that Node can
 * catch, so there is no interrupt there for a listener to observe.
 */

const require = createRequire(import.meta.url)
const CLI_BIN = resolve(dirname(require.resolve("@aburi/cli/package.json")), "dist/bin/aburi.mjs")

/**
 * An effects plugin whose module never finishes loading: it announces itself through a file,
 * then awaits forever at the top level, with a timer keeping the event loop alive (an unsettled
 * promise alone would let the process exit 0). Asynchronously, so the loop stays free to deliver
 * the signal, which a synchronous stall inside `classify` would not.
 */
const STALLING_PLUGIN = `
import { writeFileSync } from "node:fs"
writeFileSync(process.env.ABURI_TEST_READY_FILE, "waiting")
await new Promise(() => setInterval(() => {}, 1000))
export const plugin = {
  manifest: {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "effects-stall",
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: [],
    },
  },
  async init() {},
  classify() {
    return null
  },
}
`

let repo = ""
let child: ChildProcess | null = null

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" })
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
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"])
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1"])
  await writeFile(join(repo, "src/a.ts"), "export function a(): number { return 2 }\n")
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "c2"])
})

afterEach(async () => {
  child?.kill("SIGKILL")
  child = null
  await rm(repo, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("aburi diff, interrupted in the base scan", () => {
  it.each([
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ] as const)("removes the worktree and its checkout on %s, and still dies of the signal", async (signal) => {
    const ready = join(repo, "ready")
    const running = spawn(process.execPath, [CLI_BIN, "diff", "HEAD~1..HEAD"], {
      cwd: repo,
      env: { ...process.env, ABURI_TEST_READY_FILE: ready },
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
  }, 30_000)
})
