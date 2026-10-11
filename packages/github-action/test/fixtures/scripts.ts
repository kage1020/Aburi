import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts")

export interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunOptions {
  readonly args?: readonly string[]
  readonly cwd?: string
  /** The script's whole environment besides `PATH`; omitted, it inherits this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Run one of the committed `scripts/*.mjs` the way a step does; a non-zero exit is a result. */
export async function runScript(name: string, options: RunOptions = {}): Promise<RunResult> {
  const env =
    options.env === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries({ PATH: process.env.PATH ?? "", ...options.env }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
  try {
    const done = await execFileAsync(
      process.execPath,
      [join(SCRIPTS, name), ...(options.args ?? [])],
      { cwd: options.cwd, env },
    )
    return { status: 0, stdout: done.stdout, stderr: done.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      status: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    }
  }
}

/** The `key=value` lines a step writes to `$GITHUB_OUTPUT`, as the runner reads them back. */
export function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return outputs
}
