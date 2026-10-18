import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { beforeAll } from "vitest"

export const CLI_BIN = fileURLToPath(new URL("../../dist/bin/aburi.mjs", import.meta.url))

export function requireBuiltBin(): void {
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
