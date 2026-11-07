import type { Logger } from "@aburi/types"
import type { TreeReleaseFailure } from "./pipeline"

export type ExtractionLogLevel = keyof Logger

/**
 * What extracting one file said, kept for the thread that collates every file's to say in file
 * order. An event with `once` came out of a computation each extractor runs for the first file
 * that needs it and remembers after, so it belongs to the first file in the run that carries it.
 */
export type ExtractionEvent =
  | {
      readonly kind: "log"
      readonly level: ExtractionLogLevel
      readonly message: string
      readonly meta?: Record<string, unknown>
      readonly once?: string
    }
  | {
      /** A line of a language's import resolver; the run says each distinct one once. */
      readonly kind: "resolver-log"
      readonly plugin: string
      readonly level: ExtractionLogLevel
      readonly message: string
      readonly meta?: Record<string, unknown>
    }
  | {
      readonly kind: "resolver-fault"
      readonly plugin: string
      readonly message: string
      readonly once: string
    }
  | {
      readonly kind: "tree-release-failure"
      readonly failure: TreeReleaseFailure
      readonly once?: string
    }

/** The `once` of what reading a file's import edges said: a file the run extracted needs no read. */
export function edgesReadOnce(path: string): string {
  return `edges\0${path}`
}

export function eventLogger(
  event: (level: ExtractionLogLevel, message: string, meta?: Record<string, unknown>) => void,
): Logger {
  return {
    debug: (message, meta) => event("debug", message, meta),
    info: (message, meta) => event("info", message, meta),
    warn: (message, meta) => event("warn", message, meta),
    error: (message, meta) => event("error", message, meta),
  }
}
