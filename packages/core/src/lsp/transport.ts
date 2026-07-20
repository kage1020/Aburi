import { type ChildProcess, spawn } from "node:child_process"
import { platform } from "node:process"
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"

/**
 * A spawned stdio-mode LSP server plus the JSON-RPC connection wired to its pipes.
 * The connection is unstarted; the caller decides when to `listen()` (typically the
 * client wrapper does it during `initialize`).
 */
export interface SpawnedServer {
  process: ChildProcess
  connection: MessageConnection
  /** Resolves with the exit code when the server terminates. */
  exited: Promise<number | null>
  /** Force-kill after a graceful shutdown grace period (lsp-enrichment.md §4.1: 1 s → SIGKILL). */
  killAfter(graceMs: number): Promise<void>
}

/**
 * Spawn an LSP server binary in stdio mode.
 *
 * Windows note: `.cmd` shims cannot be spawned without `shell: true`. To keep the
 * command surface secure (no shell interpolation of user config), we set `shell` to
 * true only on Windows AND only when the resolved command basename ends in `.cmd`
 * or `.bat`. Absolute paths to `.exe` and posix binaries stay in the safe path.
 */
export function spawnStdioServer(
  command: string,
  args: readonly string[],
  cwd: string,
): SpawnedServer {
  const useShell = shouldUseShell(command)
  const child = spawn(command, [...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    windowsHide: true,
  })

  if (child.stdin === null || child.stdout === null) {
    child.kill()
    throw new Error(`Spawned LSP server "${command}" is missing stdin/stdout pipes.`)
  }

  const reader = new StreamMessageReader(child.stdout)
  const writer = new StreamMessageWriter(child.stdin)
  const connection = createMessageConnection(reader, writer)

  // Swallow stderr but keep the pipe drained. LSP servers write diagnostic noise
  // there routinely; we do not surface it in the IR path.
  child.stderr?.on("data", () => {})

  const exited = new Promise<number | null>((resolvePromise) => {
    child.once("exit", (code) => {
      resolvePromise(code)
    })
  })

  return {
    process: child,
    connection,
    exited,
    async killAfter(graceMs) {
      if (child.exitCode !== null) return
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
      }, graceMs)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function shouldUseShell(command: string): boolean {
  if (platform !== "win32") return false
  const lowered = command.toLowerCase()
  return lowered.endsWith(".cmd") || lowered.endsWith(".bat")
}
