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
  /**
   * Resolves with the exit code when the server terminates. Never rejects —
   * spawn errors (ENOENT, EACCES) are surfaced through `spawnError` instead
   * so a single `await` on this promise cannot leave the pass hanging when
   * the child never actually starts.
   */
  exited: Promise<number | null>
  /**
   * Non-null when the child process failed to spawn or emitted a fatal
   * runtime error. Read after any operation that would otherwise hang.
   */
  spawnError: Promise<Error | null>
  /**
   * Force-kill after a graceful shutdown grace period (lsp-enrichment.md §4.1:
   * 1 s → SIGKILL). Returns after at most two grace periods whether or not the
   * child is reaped: waiting on `exit` without a bound would reintroduce, one
   * layer down, the same stall the §4.4 write bounds exist to prevent — a
   * process wedged in uninterruptible I/O does not answer SIGKILL either.
   */
  killAfter(graceMs: number): Promise<void>
}

/**
 * Spawn an LSP server binary in stdio mode.
 *
 * Windows `.cmd` / `.bat` note: Node.js's own child_process on Windows refuses
 * to spawn `.cmd` / `.bat` files without `shell: true` (per its CVE-2024-27980
 * fix — an argument-escaping bug that was closed by requiring the shell path
 * for those extensions). We therefore set `shell: true` ONLY when the resolved
 * command basename ends in `.cmd` / `.bat`; other cases (posix binaries,
 * Windows `.exe`) take the shell-free code path. Node handles argument
 * escaping under `shell: true` — it does not concatenate a naive command
 * string. Configuration values still come from the user's `aburi.json` and
 * MUST be treated as trusted input; nothing in this file protects against a
 * user pointing `command` at a hostile binary.
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

  // Swallow stderr but keep the pipe drained. LSP servers write diagnostic
  // noise there routinely; we do not surface it in the IR path.
  child.stderr?.on("data", () => {})

  let resolveSpawnError: (value: Error | null) => void = () => {}
  const spawnError = new Promise<Error | null>((resolvePromise) => {
    resolveSpawnError = resolvePromise
  })

  const exited = new Promise<number | null>((resolvePromise) => {
    let exitResolved = false
    child.once("exit", (code) => {
      if (exitResolved) return
      exitResolved = true
      resolveSpawnError(null)
      resolvePromise(code)
    })
    child.once("error", (error) => {
      if (exitResolved) return
      exitResolved = true
      resolveSpawnError(error instanceof Error ? error : new Error(String(error)))
      // Resolve exited too so anything awaiting it does not hang; the caller
      // checks `spawnError` to see whether the child actually ran.
      resolvePromise(null)
    })
  })

  return {
    process: child,
    connection,
    exited,
    spawnError,
    async killAfter(graceMs) {
      if (child.exitCode !== null) return
      await raceExit(exited, graceMs)
      if (child.exitCode !== null) return
      child.kill("SIGKILL")
      await raceExit(exited, graceMs)
    },
  }
}

/** Wait for the child to exit, giving up after `ms` so no caller can be pinned. */
async function raceExit(exited: Promise<number | null>, ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    exited.then(() => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

function shouldUseShell(command: string): boolean {
  if (platform !== "win32") return false
  const lowered = command.toLowerCase()
  return lowered.endsWith(".cmd") || lowered.endsWith(".bat")
}
