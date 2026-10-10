import { type ChildProcess, spawn } from "node:child_process"
import { platform } from "node:process"
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node"

export interface SpawnedServer {
  process: ChildProcess
  connection: MessageConnection
  exited: Promise<number | null>
  spawnError: Promise<Error | null>
  killAfter(graceMs: number): Promise<void>
}

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
