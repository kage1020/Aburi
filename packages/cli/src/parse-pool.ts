import { createRequire } from "node:module"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { frameworkHintPlugins } from "@aburi/config"
import {
  createFileExtractor,
  type ExtractionEvent,
  type ExtractionJob,
  type FileExtraction,
  type FileExtractor,
  type ParsePool,
} from "@aburi/core"
import type { Config } from "@aburi/types"
import { CliError, errorMessage, internalFault } from "./errors"
import { loadPlugins } from "./plugin-loader"
import {
  describedForThread,
  ifCloneable,
  rebuiltFromThread,
  type ThreadThrown,
} from "./thread-errors"

/** What a parser worker loads the scan's plugins from: what the scan itself loaded them from. */
export interface ParserSetup {
  /** The config the scan read, with the options the command line overrode. */
  readonly config: Config
  readonly workspaceRoot: string
  readonly pluginRefRoot: string
}

export interface ParsePoolOptions {
  readonly size: number
  readonly setup: ParserSetup
}

interface ParserData {
  readonly job: ExtractionJob
  readonly setup: ParserSetup
}

type ToWorker = { readonly kind: "extract"; readonly fileId: number }

type FromWorker =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly thrown: ThreadThrown }
  | {
      readonly kind: "extracted"
      readonly extraction: FileExtraction
      /** The error of a `fatal` outcome, whose own `error` is left out. */
      readonly thrown?: ThreadThrown
    }

interface Pending {
  readonly fileId: number
  resolve(extraction: FileExtraction): void
  reject(error: unknown): void
}

interface Slot {
  readonly worker: Worker
  readonly inFlight: Pending[]
  ready: boolean
  ended: boolean
}

/** Two, so a worker has its next file before it answers for the one it has. */
const IN_FLIGHT_PER_WORKER = 2

const ENDS_BEFORE_ABORT = 3

// V8's default stack on the main thread is 984 KiB, and Node keeps 192 KiB of a worker's for
// itself: a file nested deep enough to exhaust one thread's stack exhausts the other's.
const STACK_SIZE_MB = (984 + 192) / 1024

const ON_THE_MAIN_THREAD = "Run with --concurrency 1 to extract every file on the main thread."

/**
 * Workers that each load the scan's plugins and extract the files they are handed, one at a
 * time and in the order they were asked for. A worker that ends under a file withdraws that file
 * and is replaced; the third that ends stops the pool.
 */
export function createParsePool(job: ExtractionJob, options: ParsePoolOptions): ParsePool {
  const queue: Pending[] = []
  const slots: Slot[] = []
  const ended: string[] = []
  let stopped: unknown = null
  const data: ParserData = { job, setup: options.setup }
  const path = parserWorkerPath()

  const fileOf = (fileId: number): string => job.files[fileId]?.path ?? `file ${fileId}`

  const stop = (error: unknown): void => {
    if (stopped !== null) return
    stopped = error
    const pending = [...slots.flatMap((slot) => slot.inFlight.splice(0)), ...queue.splice(0)]
    for (const entry of pending) entry.reject(error)
    for (const slot of slots) {
      slot.ended = true
      void slot.worker.terminate()
    }
  }

  const dispatch = (): void => {
    if (stopped !== null) return
    for (let depth = 1; depth <= IN_FLIGHT_PER_WORKER; depth++) {
      for (const [index, slot] of slots.entries()) {
        if (queue.length === 0) return
        const live = slot.ended ? spawn(index) : slot
        if (live.inFlight.length >= depth) continue
        const next = queue.shift()
        if (next === undefined) return
        live.inFlight.push(next)
        live.worker.postMessage({ kind: "extract", fileId: next.fileId } satisfies ToWorker)
      }
    }
  }

  const received = (slot: Slot, message: FromWorker): void => {
    if (slot.ended) return
    switch (message.kind) {
      case "ready":
        slot.ready = true
        return
      case "failed":
        stop(
          new CliError(
            `A parser worker failed: ${errorMessage(rebuiltFromThread(message.thrown))}\n${ON_THE_MAIN_THREAD}`,
            "runtime-error",
            { cause: rebuiltFromThread(message.thrown) },
          ),
        )
        return
      case "extracted": {
        const { extraction } = message
        const answered = slot.inFlight[0]
        if (answered?.fileId !== extraction.fileId) {
          stop(
            internalFault(
              " while extracting files on parser workers",
              `a worker answered for ${fileOf(extraction.fileId)} while ${answered === undefined ? "it had no file" : `${fileOf(answered.fileId)} was its next`}`,
              null,
            ),
          )
          return
        }
        slot.inFlight.shift()
        answered.resolve(
          message.thrown === undefined
            ? extraction
            : {
                ...extraction,
                outcome: { kind: "fatal", error: rebuiltFromThread(message.thrown) },
              },
        )
        dispatch()
        return
      }
      default:
        stop(
          internalFault(
            " while extracting files on parser workers",
            `a worker sent ${JSON.stringify(message satisfies never)}, a message of no known kind`,
            null,
          ),
        )
    }
  }

  const endedUnder = (slot: Slot, how: string): void => {
    if (slot.ended || stopped !== null) return
    slot.ended = true
    void slot.worker.terminate()
    if (!slot.ready) {
      stop(
        new CliError(
          `A parser worker ${how} before it had loaded the scan's plugins.\n${ON_THE_MAIN_THREAD}`,
          "runtime-error",
        ),
      )
      return
    }
    const culprit = slot.inFlight[0]
    ended.push(culprit === undefined ? "between files" : `extracting ${fileOf(culprit.fileId)}`)
    if (ended.length >= ENDS_BEFORE_ABORT) {
      stop(
        new CliError(
          `Parser workers ended ${ended.length} times (${ended.join("; ")}), so the plugins, not ` +
            `one file, are ending them. ${ON_THE_MAIN_THREAD}`,
          "runtime-error",
        ),
      )
      return
    }
    slot.inFlight.shift()
    queue.unshift(...slot.inFlight.splice(0))
    culprit?.resolve({
      fileId: culprit.fileId,
      outcome: {
        kind: "crashed",
        detail: `the parser worker extracting it ${how}. ${ON_THE_MAIN_THREAD}`,
      },
      events: [],
    })
    dispatch()
  }

  const spawn = (index: number): Slot => {
    const worker = new Worker(path, {
      workerData: data,
      resourceLimits: { stackSizeMb: STACK_SIZE_MB },
    })
    const slot: Slot = { worker, inFlight: [], ready: false, ended: false }
    worker.on("message", (message: FromWorker) => received(slot, message))
    worker.on("error", (error: Error) => endedUnder(slot, describeWorkerError(error)))
    worker.on("exit", (code) =>
      endedUnder(slot, `ended with exit code ${code}; a plugin may have called process.exit()`),
    )
    slots[index] = slot
    return slot
  }

  for (let index = 0; index < options.size; index++) spawn(index)

  return {
    extract(fileId) {
      return new Promise<FileExtraction>((resolve, reject) => {
        if (stopped !== null) {
          reject(stopped)
          return
        }
        queue.push({ fileId, resolve, reject })
        dispatch()
      })
    },
    async close() {
      stop(new CliError("The parser workers were stopped before they finished.", "runtime-error"))
      await Promise.all(slots.map((slot) => slot.worker.terminate()))
    },
  }
}

/** The worker's side of `createParsePool`. */
export function serveParseRequests(): void {
  const port = parentPort
  if (port === null) {
    throw internalFault(" while serving parse requests", "it ran outside a worker thread", null)
  }
  const send = (message: FromWorker): void => port.postMessage(message)
  const { job, setup } = workerData as ParserData
  const extractor: Promise<FileExtractor> = loadPlugins({
    config: setup.config,
    workspaceRoot: setup.workspaceRoot,
    pluginRefRoot: setup.pluginRefRoot,
    syntheticPlugins: frameworkHintPlugins(setup.config),
  }).then((plugins) => {
    send({ kind: "ready" })
    return createFileExtractor(job, plugins)
  })
  extractor.catch((error: unknown) => send({ kind: "failed", thrown: describedForThread(error) }))
  port.on("message", (message: ToWorker) => {
    extractor
      .then((ready) => ready.extract(message.fileId))
      .then(
        (extraction) => {
          const answer = portable(extraction)
          try {
            send(answer)
          } catch (error) {
            send(uncloneable(answer.extraction, error))
          }
        },
        (error: unknown) => send({ kind: "failed", thrown: describedForThread(error) }),
      )
  })
}

/** The file's events, whose metadata `portable` has made cloneable, with its outcome withdrawn. */
function uncloneable(extraction: FileExtraction, error: unknown): FromWorker {
  return {
    kind: "extracted",
    extraction: {
      fileId: extraction.fileId,
      outcome: {
        kind: "threw",
        message: `its extraction holds a value that cannot leave the parser worker: ${errorMessage(error)}`,
      },
      events: extraction.events,
    },
  }
}

function portable(extraction: FileExtraction): Extract<FromWorker, { kind: "extracted" }> {
  const events = extraction.events.map(withCloneableMeta)
  if (extraction.outcome.kind !== "fatal") {
    return { kind: "extracted", extraction: { ...extraction, events } }
  }
  return {
    kind: "extracted",
    extraction: { ...extraction, events, outcome: { kind: "fatal", error: undefined } },
    thrown: describedForThread(extraction.outcome.error),
  }
}

function withCloneableMeta(event: ExtractionEvent): ExtractionEvent {
  if (!("meta" in event) || event.meta === undefined) return event
  const meta = ifCloneable(event.meta) as Record<string, unknown> | undefined
  if (meta !== undefined) return event
  const { meta: _dropped, ...rest } = event
  return rest
}

function describeWorkerError(error: Error): string {
  if ((error as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY") {
    return `ran out of memory: ${error.message}`
  }
  return `threw outside the scan's own error handling: ${error.stack ?? error.message}`
}

function parserWorkerPath(): string {
  try {
    return createRequire(import.meta.url).resolve("#parse-worker")
  } catch (error) {
    // A bundle that inlines @aburi/cli leaves its worker script behind.
    throw new CliError(
      `The worker script that extracts files on parser workers cannot be found from ${import.meta.url}. ${ON_THE_MAIN_THREAD}`,
      "runtime-error",
      { cause: error },
    )
  }
}
