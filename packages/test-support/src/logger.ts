import type { Logger } from "@aburi/types"

/** A `Logger` that discards everything. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface LoggedDebug {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

export interface RecordingLogger extends Logger {
  readonly debugs: LoggedDebug[]
  readonly infos: string[]
  readonly warnings: string[]
  readonly errors: string[]
}

/** A `Logger` that keeps every message in order: debug ones with their meta, the rest as text. */
export function recordingLogger(): RecordingLogger {
  const debugs: LoggedDebug[] = []
  const infos: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  return {
    debugs,
    infos,
    warnings,
    errors,
    debug: (message, meta) => {
      debugs.push({ message, meta })
    },
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
