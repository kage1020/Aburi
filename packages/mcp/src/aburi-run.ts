import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, sep } from "node:path"

export interface AburiRun {
  /** The arguments the CLI was given, the server's own output directories included. */
  readonly argv: readonly string[]
  /** `null` when the run ended on a signal rather than with a code. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface AburiRunOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

const KILL_AFTER_MS = 5_000

/**
 * Runs the `aburi` CLI in a process of its own. A run settles only once its process has exited,
 * so the next run never meets a cancelled one still cleaning up.
 */
export function runAburi(argv: readonly string[], options: AburiRunOptions): Promise<AburiRun> {
  return new Promise((done, fail) => {
    const { signal } = options
    if (signal?.aborted === true) {
      fail(signal.reason)
      return
    }
    const child = spawn(process.execPath, [aburiBin(options.cwd), ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let escalation: NodeJS.Timeout | undefined
    const stop = () => {
      child.kill("SIGTERM")
      // A plugin can hold SIGTERM, and the call it served has already ended.
      escalation = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS)
    }
    signal?.addEventListener("abort", stop, { once: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", fail)
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop)
      clearTimeout(escalation)
      done({
        argv,
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}

/**
 * The workspace's own CLI when `cwd` resolves one, since a plugin `aburi.json` names by package is
 * imported from where the CLI is installed; else the CLI this package was installed with.
 */
function aburiBin(cwd: string): string {
  const manifestPath =
    resolveFrom(`${resolve(cwd)}${sep}`) ?? createRequire(import.meta.url).resolve(MANIFEST)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: { aburi?: unknown }
  }
  const bin = manifest.bin?.aburi
  if (typeof bin !== "string") {
    throw new Error(`${manifestPath} declares no "aburi" command in its "bin" field.`)
  }
  return resolve(dirname(manifestPath), bin)
}

const MANIFEST = "@aburi/cli/package.json"

function resolveFrom(directory: string): string | null {
  try {
    return createRequire(directory).resolve(MANIFEST)
  } catch {
    return null
  }
}
