import type { Logger } from "@aburi/types"
import type { LogLevel } from "./env"

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LoggerOptions {
  /**
   * Lowest level that reaches the sink. Defaults to `warn`, which is what the
   * CLI has always printed; `ABURI_LOG_LEVEL` (§11) raises or lowers it. Until
   * that variable was wired through, `debug` and `info` were hard-coded no-ops
   * and a pass logging at those levels could not be heard from at all.
   */
  minimum?: LogLevel
  /** Sink for a fully formatted line, newline included. Defaults to stderr. */
  write?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVEL_RANK[options.minimum ?? "warn"]
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(line)
    })
  const at =
    (level: LogLevel) =>
    (message: string): void => {
      if (LOG_LEVEL_RANK[level] < threshold) return
      write(`${level}: ${message}\n`)
    }
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  }
}
