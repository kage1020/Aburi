import { availableParallelism } from "node:os"
import type { ParsePoolFactory } from "@aburi/core"
import type { LanguagePlugin, Logger } from "@aburi/types"
import { CliError } from "./errors"
import { createParsePool, type ParserSetup } from "./parse-pool"

/** What a language plugin that declares no `wasmHeapPerWorkerMB` is budgeted. */
export const DEFAULT_HEAP_PER_WORKER_MB = 256

/**
 * Less source than this for each worker, and starting one, which loads every plugin again, costs
 * more than the extraction it takes off the others.
 */
export const BYTES_PER_WORKER = 256 * 1024

export interface ParserSizing {
  /** `--concurrency`, or undefined for the default. */
  readonly requested: number | undefined
  readonly fileCount: number
  readonly sourceBytes: number
  readonly heapPerWorkerMb: number
  readonly availableMemoryMb: number
  readonly parallelism: number
  /** The scans running at once on this machine, which share its processors and memory. */
  readonly scansAtOnce: number
}

export function requireWorkerCount(concurrency: number | undefined): void {
  if (concurrency === undefined || (Number.isSafeInteger(concurrency) && concurrency >= 1)) return
  throw new CliError(
    `--concurrency must be a positive integer (got ${String(concurrency)}).`,
    "input-error",
  )
}

/** How many workers extract the files; one means the scan extracts them on its own thread. */
export function parserWorkers(sizing: ParserSizing): number {
  const wanted =
    sizing.requested ?? Math.max(1, Math.ceil((sizing.parallelism - 1) / sizing.scansAtOnce))
  const memory = Math.floor(sizing.availableMemoryMb / sizing.scansAtOnce / sizing.heapPerWorkerMb)
  const work =
    sizing.requested === undefined
      ? Math.floor(sizing.sourceBytes / BYTES_PER_WORKER)
      : sizing.fileCount
  return Math.max(1, Math.min(wanted, memory, work))
}

/** Sized for the hungriest language, since any worker may be handed any file. */
export function heapPerWorkerMb(languages: readonly LanguagePlugin[]): number {
  return Math.max(
    0,
    ...languages.map(
      (language) =>
        language.manifest.capabilities?.wasmHeapPerWorkerMB ?? DEFAULT_HEAP_PER_WORKER_MB,
    ),
  )
}

export interface ParserConcurrency {
  readonly requested: number | undefined
  readonly scansAtOnce: number
  readonly languages: readonly LanguagePlugin[]
  readonly setup: ParserSetup
  readonly logger: Logger
}

export function parsePoolFor(concurrency: ParserConcurrency): ParsePoolFactory {
  return (job) => {
    const heap = heapPerWorkerMb(concurrency.languages)
    const sizing: ParserSizing = {
      requested: concurrency.requested,
      fileCount: job.files.length,
      sourceBytes: job.files.reduce((total, file) => total + file.size, 0),
      heapPerWorkerMb: heap,
      availableMemoryMb: process.availableMemory() / 2 ** 20,
      parallelism: availableParallelism(),
      scansAtOnce: concurrency.scansAtOnce,
    }
    const workers = parserWorkers(sizing)
    // The default leaves a small workspace on the main thread, and saying so on every scan of one
    // would only add a line that changes with the machine.
    if (workers > 1 || (sizing.requested ?? 1) > 1) {
      concurrency.logger.debug(
        `scan: extracting on ${workers === 1 ? "the main thread" : `${workers} parser workers`} ` +
          `(${describeSizing(sizing)})`,
      )
    }
    return workers === 1 ? null : createParsePool(job, { size: workers, setup: concurrency.setup })
  }
}

function describeSizing(sizing: ParserSizing): string {
  const asked =
    sizing.requested === undefined
      ? `${sizing.parallelism} processors`
      : `--concurrency ${sizing.requested}`
  const shared = sizing.scansAtOnce === 1 ? "" : `, shared by ${sizing.scansAtOnce} scans`
  return (
    `${asked}${shared}, ${sizing.fileCount} files of ${Math.round(sizing.sourceBytes / 1024)} KiB, ` +
    `${Math.floor(sizing.availableMemoryMb)} MiB free at ${sizing.heapPerWorkerMb} MiB a worker`
  )
}
