import { createRequire } from "node:module"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { CliError, errorMessage, internalFault } from "../errors"
import { describedForThread, rebuiltFromThread, type ThreadThrown } from "../thread-errors"
import type { WarnFn } from "../warn"
import { runScan, type ScanOptions } from "./scan"
import type { ScanReport } from "./scan-report"

type DataOnly<T> = {
  [K in keyof T]: NonNullable<T[K]> extends (...args: never[]) => unknown ? never : T[K]
}

/**
 * Options either side of a diff scans with. The base's are cloned into a thread, so none may be a
 * function; `log` and `incidents` stay with the caller, which decides where a scan's lines go and
 * when its incidents are said.
 */
export type PortableScanOptions = DataOnly<Omit<ScanOptions, "log" | "incidents">>

export interface ThreadedScan {
  /** How a failure of the thread itself names the scan, as `base ref "main"`. */
  name: string
  log: (line: string) => void
  warn: WarnFn
}

type FromThread =
  | { kind: "log"; line: string }
  | { kind: "done"; report: ScanReport }
  | { kind: "failed"; thrown: ThreadThrown }

const PHASE = " while scanning in a worker thread"

const ON_THE_MAIN_THREAD =
  "Run with --no-parallel-scans (parallelScans: false) to scan it on the main thread."

/** `runScan` on a thread of its own; its log lines reach `log` in the order it wrote them. */
export function scanInThread(
  options: PortableScanOptions,
  scan: ThreadedScan,
): Promise<ScanReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scanWorkerPath(scan.name), { workerData: options })
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
          scan.log(message.line)
          break
        case "done":
          settle(() => resolve(message.report))
          break
        case "failed":
          settle(() => reject(rebuiltFromThread(message.thrown)))
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
  const options = workerData as PortableScanOptions
  const send = (message: FromThread): void => port.postMessage(message)
  runScan({ ...options, log: (line) => send({ kind: "log", line }) })
    .then((report) => send({ kind: "done", report }))
    .catch((error: unknown) => send({ kind: "failed", thrown: describedForThread(error) }))
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
