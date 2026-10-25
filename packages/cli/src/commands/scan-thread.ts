import { createRequire } from "node:module"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { CliError, type CliErrorCode, internalFault } from "../errors"
import { runScan, type ScanOptions } from "./scan"
import type { ScanReport } from "./scan-report"

/** What crosses into the thread: data alone, since a function cannot be cloned there. */
export type ThreadScanOptions = Omit<ScanOptions, "log" | "incidents">

type Thrown =
  | { kind: "cli"; message: string; code: CliErrorCode; stack: string | undefined }
  | { kind: "error"; name: string; message: string; stack: string | undefined }
  | { kind: "value"; text: string }

type FromThread =
  | { kind: "log"; line: string }
  | { kind: "done"; report: ScanReport }
  | { kind: "failed"; thrown: Thrown }

const PHASE = " while scanning in a worker thread"

/** `runScan` on a thread of its own; its log lines reach `log` in the order it wrote them. */
export function scanInThread(
  options: ThreadScanOptions,
  log: (line: string) => void,
): Promise<ScanReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scanWorkerPath(), { workerData: options })
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
          log(message.line)
          break
        case "done":
          settle(() => resolve(message.report))
          break
        case "failed":
          settle(() => reject(rebuilt(message.thrown)))
          break
      }
    })
    worker.on("error", (error) => {
      if (!settled) settle(() => reject(error))
    })
    worker.on("exit", (code) => {
      if (!settled) {
        settled = true
        reject(
          internalFault(PHASE, `the thread exited with code ${code} before the scan ended`, null),
        )
      }
    })
  })
}

/** The worker thread's side of `scanInThread`. */
export function serveScan(): void {
  const port = parentPort
  if (port === null) throw internalFault(PHASE, "serveScan ran outside a worker thread", null)
  const options = workerData as ThreadScanOptions
  const send = (message: FromThread): void => port.postMessage(message)
  runScan({ ...options, log: (line) => send({ kind: "log", line }) }).then(
    (report) => send({ kind: "done", report }),
    (error: unknown) => send({ kind: "failed", thrown: described(error) }),
  )
}

function scanWorkerPath(): string {
  try {
    return createRequire(import.meta.url).resolve("#scan-worker")
  } catch (error) {
    throw internalFault(
      PHASE,
      "the worker script is missing from this install of @aburi/cli",
      error,
    )
  }
}

function described(error: unknown): Thrown {
  if (error instanceof CliError) {
    return { kind: "cli", message: error.message, code: error.code, stack: error.stack }
  }
  if (error instanceof Error) {
    return { kind: "error", name: error.name, message: error.message, stack: error.stack }
  }
  return { kind: "value", text: String(error) }
}

function rebuilt(thrown: Thrown): unknown {
  switch (thrown.kind) {
    case "cli":
      return withStack(new CliError(thrown.message, thrown.code), thrown.stack)
    case "error": {
      const error = withStack(new Error(thrown.message), thrown.stack)
      error.name = thrown.name
      return error
    }
    case "value":
      return thrown.text
  }
}

function withStack<T extends Error>(error: T, stack: string | undefined): T {
  if (stack !== undefined) error.stack = stack
  return error
}
