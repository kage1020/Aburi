import { createRequire } from "node:module"
import { parentPort, Worker, workerData } from "node:worker_threads"
import type { ScanProgress } from "@aburi/core"
import type { LogLevel } from "../env"
import { CliError, type CliErrorCode, errorMessage, internalFault } from "../errors"
import type { LogWrite } from "../logger"
import type { WarnFn } from "../warn"
import { runScan, type ScanOptions } from "./scan"
import type { ScanReport } from "./scan-report"

type DataOnly<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: never[]) => unknown ? never : T[K]
}

/**
 * Options either side of a diff scans with. The base's are cloned into a thread, so none may be a
 * function; `log`, `progress` and `incidents` stay with the caller, which decides where a scan's
 * lines go and when its incidents are said.
 */
export type PortableScanOptions = DataOnly<Omit<ScanOptions, "log" | "progress" | "incidents">>

export interface ThreadedScan {
  /** How a failure of the thread itself names the scan, as `base ref "main"`. */
  name: string
  log: LogWrite
  progress?: (progress: ScanProgress) => void
  warn: WarnFn
}

type Thrown =
  | {
      kind: "cli"
      message: string
      code: CliErrorCode
      stack: string | undefined
      cause: unknown
    }
  | {
      kind: "error"
      name: string
      message: string
      stack: string | undefined
      code: unknown
      cause: unknown
    }
  | { kind: "value"; text: string }

interface ThreadData {
  options: PortableScanOptions
  /** Whether the caller shows progress, so that a thread nobody watches posts none. */
  progress: boolean
}

type FromThread =
  | { kind: "log"; line: string; level: LogLevel }
  | { kind: "progress"; progress: ScanProgress }
  | { kind: "done"; report: ScanReport }
  | { kind: "failed"; thrown: Thrown }

const PHASE = " while scanning in a worker thread"

const ON_THE_MAIN_THREAD =
  "Run with --no-parallel-scans (parallelScans: false) to scan it on the main thread."

/** `runScan` on a thread of its own; its log lines and progress reach `scan` in the order sent. */
export function scanInThread(
  options: PortableScanOptions,
  scan: ThreadedScan,
): Promise<ScanReport> {
  return new Promise((resolve, reject) => {
    const data: ThreadData = { options, progress: scan.progress !== undefined }
    const worker = new Worker(scanWorkerPath(scan.name), { workerData: data })
    let settled = false
    const settle = (finish: () => void): void => {
      settled = true
      finish()
      // A plugin may leave a handle open, which would keep the thread, and so the process, alive.
      void worker.terminate()
    }
    worker.on("message", (message: FromThread) => {
      switch (message.kind) {
        case "log":
          scan.log(message.line, message.level)
          break
        case "progress":
          scan.progress?.(message.progress)
          break
        case "done":
          settle(() => resolve(message.report))
          break
        case "failed":
          settle(() => reject(rebuilt(message.thrown)))
          break
        default:
          settle(() =>
            reject(
              internalFault(
                PHASE,
                `the thread sent ${JSON.stringify(message satisfies never)}, a message of no known kind`,
                null,
              ),
            ),
          )
      }
    })
    worker.on("error", (error: unknown) => {
      if (settled) {
        scan.warn(
          `⚠ The scan of ${scan.name} threw on its worker thread after it ended: ${errorMessage(error)}`,
        )
        return
      }
      settle(() =>
        reject(
          new CliError(
            `The scan of ${scan.name} threw outside its own error handling, on its worker thread: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${ON_THE_MAIN_THREAD}`,
            "runtime-error",
            { cause: error },
          ),
        ),
      )
    })
    worker.on("exit", (code) => {
      if (settled) return
      settled = true
      reject(
        new CliError(
          `The scan of ${scan.name} ended its worker thread with exit code ${code} before it finished; a plugin may have called process.exit(). ${ON_THE_MAIN_THREAD}`,
          "runtime-error",
        ),
      )
    })
  })
}

/** The worker thread's side of `scanInThread`. */
export function serveScan(): void {
  const port = parentPort
  if (port === null) throw internalFault(PHASE, "serveScan ran outside a worker thread", null)
  const { options, progress } = workerData as ThreadData
  const send = (message: FromThread): void => port.postMessage(message)
  runScan({
    ...options,
    log: (line, level) => send({ kind: "log", line, level }),
    ...(progress ? { progress: (sent) => send({ kind: "progress", progress: sent }) } : {}),
  })
    .then((report) => send({ kind: "done", report }))
    .catch((error: unknown) => send({ kind: "failed", thrown: described(error) }))
}

function scanWorkerPath(name: string): string {
  try {
    return createRequire(import.meta.url).resolve("#scan-worker")
  } catch (error) {
    // A bundle that inlines @aburi/cli leaves its worker script behind.
    throw new CliError(
      `The worker script that scans ${name} on a thread of its own cannot be found from ${import.meta.url}. ${ON_THE_MAIN_THREAD}`,
      "runtime-error",
      { cause: error },
    )
  }
}

function described(error: unknown): Thrown {
  if (error instanceof CliError) {
    return {
      kind: "cli",
      message: error.message,
      code: error.code,
      stack: error.stack,
      cause: ifCloneable(error.cause),
    }
  }
  if (error instanceof Error) {
    return {
      kind: "error",
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: ifCloneable((error as { code?: unknown }).code),
      cause: ifCloneable(error.cause),
    }
  }
  return { kind: "value", text: String(error) }
}

function ifCloneable(value: unknown): unknown {
  try {
    structuredClone(value)
    return value
  } catch {
    return undefined
  }
}

function rebuilt(thrown: Thrown): unknown {
  switch (thrown.kind) {
    case "cli":
      return withStack(
        new CliError(thrown.message, thrown.code, causeOf(thrown.cause)),
        thrown.stack,
      )
    case "error": {
      const error = withStack(new Error(thrown.message, causeOf(thrown.cause)), thrown.stack)
      error.name = thrown.name
      if (thrown.code !== undefined) Object.assign(error, { code: thrown.code })
      return error
    }
    case "value":
      return thrown.text
  }
}

function causeOf(cause: unknown): { cause: unknown } | undefined {
  return cause === undefined ? undefined : { cause }
}

function withStack<T extends Error>(error: T, stack: string | undefined): T {
  if (stack !== undefined) error.stack = stack
  return error
}
