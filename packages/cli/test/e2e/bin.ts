import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gitTestEnv } from "@aburi/test-support"
import { beforeAll } from "vitest"

export const CLI_BIN: string = fileURLToPath(new URL("../../dist/bin/aburi.mjs", import.meta.url))

export function useBuiltBin(): void {
  beforeAll(() => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(`${CLI_BIN} is missing: build @aburi/cli before running this file.`)
    }
  })
}

export type OutputStream = "stdout" | "stderr"

/**
 * `unread`: the stream has no reader from the start, as a pipe has once its reader exits.
 * `refused`: the stream is a descriptor opened only for reading, which refuses every write, with
 * EBADF on every OS.
 */
export type StreamFaults = Partial<Record<OutputStream, "unread" | "refused">>

export interface BinRun {
  code: number | null
  stdout: string
  stderr: string
}

export function runBin(
  cwd: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  faults: StreamFaults = {},
): Promise<BinRun> {
  const refusing = Object.values(faults).includes("refused") ? readOnlyDescriptor() : null
  const stdio = (name: OutputStream) =>
    refusing !== null && faults[name] === "refused" ? refusing.fd : "pipe"
  return new Promise<BinRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...argv], {
      cwd,
      env,
      stdio: ["ignore", stdio("stdout"), stdio("stderr")],
    })
    const read: Record<OutputStream, string> = { stdout: "", stderr: "" }
    for (const name of ["stdout", "stderr"] as const) {
      const stream = child[name]
      if (stream === null) continue
      if (faults[name] === "unread") {
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
  }).finally(() => refusing?.close())
}

function readOnlyDescriptor(): { fd: number; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "aburi-refused-"))
  const path = join(directory, "output")
  writeFileSync(path, "")
  const fd = openSync(path, "r")
  return {
    fd,
    close: () => {
      closeSync(fd)
      rmSync(directory, { recursive: true, force: true })
    },
  }
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
