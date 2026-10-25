import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gitTestEnv } from "@aburi/test-support"
import { beforeAll } from "vitest"

export const CLI_BIN = fileURLToPath(new URL("../../dist/bin/aburi.mjs", import.meta.url))

export function useBuiltBin(): void {
  beforeAll(() => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(`${CLI_BIN} is missing: build @aburi/cli before running this file.`)
    }
  })
}

export type OutputStream = "stdout" | "stderr"

export interface BinRun {
  code: number | null
  stdout: string
  stderr: string
}

/** The stream named by `unread` has no reader from the start, as a pipe has once its reader exits. */
export function runBin(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  unread: OutputStream | null = null,
): Promise<BinRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...argv], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const read: Record<OutputStream, string> = { stdout: "", stderr: "" }
    for (const name of ["stdout", "stderr"] as const) {
      const stream = child[name]
      if (name === unread) {
        stream.destroy()
        continue
      }
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => {
        read[name] += chunk
      })
    }
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, ...read }))
  })
}

/** The linked worktrees git has registered for `repo`, the main one excluded. */
export function linkedWorktrees(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
    env: gitTestEnv(repo),
  })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1)
}

/** The `aburi-worktree-*` directories `aburi diff` made to check out a base of `repo` in. */
export async function worktreeTempDirs(repo: string): Promise<string[]> {
  const names = await readdir(tmpdir())
  return names
    .filter((name) => name.startsWith("aburi-worktree-"))
    .map((name) => join(tmpdir(), name))
    .filter((dir) => existsSync(join(dir, "base", basename(repo))))
}

export async function removeWorktreeTempDirs(repo: string): Promise<void> {
  for (const dir of await worktreeTempDirs(repo)) await rm(dir, { recursive: true, force: true })
}
