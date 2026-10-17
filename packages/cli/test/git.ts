import type { GitRunner } from "../src"

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
