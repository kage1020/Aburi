import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import type { GitRunner } from "../src"

const HOOK_AND_REPOSITORY_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]

/** An environment that keeps the developer's git config and any enclosing hook out of a fixture. */
export function gitTestEnv(anchor: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: resolve(anchor, "absent-gitconfig"),
    GIT_CONFIG_SYSTEM: resolve(anchor, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "Aburi Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Aburi Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  for (const name of HOOK_AND_REPOSITORY_ENV) delete env[name]
  return Object.assign(env, extra)
}

export function git(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, env: gitTestEnv(cwd, env) })
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

export async function initRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
}

export async function commitAll(directory: string, message = "commit"): Promise<void> {
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", message], directory)
}

export interface GitOutput {
  stdout: string
  stderr: string
}

export function gitOutput(stdout = "", stderr = ""): GitOutput {
  return { stdout, stderr }
}

export function refusedBy(message: string): () => never {
  return () => {
    throw Object.assign(new Error(message), { code: 128 })
  }
}

export interface FakeGitOptions {
  handlers?: Record<string, (args: readonly string[]) => GitOutput | Promise<GitOutput>>
  onWorktreeAdd?: (worktreeDir: string) => Promise<void> | void
}

/**
 * A git that answers every repository check as a healthy repository would, for the failures a
 * real one cannot be brought to cheaply. Handlers are keyed by a command's first two arguments.
 */
export function fakeGit(options: FakeGitOptions = {}): { runner: GitRunner; asked: string[] } {
  const asked: string[] = []
  const handlers: NonNullable<FakeGitOptions["handlers"]> = {
    "rev-parse --verify": () => gitOutput("abc\n"),
    "rev-parse --is-inside-work-tree": () => gitOutput("true\n"),
    "rev-list --all": () => gitOutput("abc\n"),
    "rev-parse --is-shallow-repository": () => gitOutput("false\n"),
    "config --bool": () => gitOutput("false\n"),
    "worktree add": async (args) => {
      const worktreeDir = args[3]
      if (worktreeDir === undefined) throw new Error(`worktree add without a path: ${args}`)
      await options.onWorktreeAdd?.(worktreeDir)
      return gitOutput()
    },
    ...options.handlers,
  }
  const runner: GitRunner = {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      asked.push(key)
      return (await handlers[key]?.(args)) ?? gitOutput()
    },
  }
  return { runner, asked }
}
