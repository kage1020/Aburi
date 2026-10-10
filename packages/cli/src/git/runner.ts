import { spawn } from "node:child_process"

export interface GitRunner {
  run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>
}

const UNINHERITED_GIT_ENV: readonly string[] = ["GIT_INDEX_FILE", "GIT_PREFIX"]

export function gitChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env }
  for (const name of UNINHERITED_GIT_ENV) delete child[name]
  return child
}

export const defaultGitRunner: GitRunner = {
  async run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: options?.cwd, env: gitChildEnv() })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })
      child.on("error", rejectPromise)
      child.on("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8")
        const stderr = Buffer.concat(stderrChunks).toString("utf8")
        if (code === 0) return resolvePromise({ stdout, stderr })
        const how =
          code === null ? `was killed by ${signal ?? "a signal"}` : `exited with code ${code}`
        rejectPromise(new Error(`git ${args.join(" ")} ${how}: ${stderr}`))
      })
    })
  },
}
