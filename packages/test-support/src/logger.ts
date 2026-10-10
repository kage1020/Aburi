import type { Logger } from "@aburi/types"

/** A `Logger` that discards everything. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface RecordingLogger extends Logger {
  readonly infos: string[]
  readonly warnings: string[]
  readonly errors: string[]
}

/** A `Logger` that keeps every info, warn and error message in order, and discards debug. */
export function recordingLogger(): RecordingLogger {
  const infos: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  return {
    infos,
    warnings,
    errors,
    debug: () => {},
    info: (message) => {
      infos.push(message)
    },
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
  }
}
