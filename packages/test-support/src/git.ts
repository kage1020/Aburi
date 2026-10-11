import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

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
