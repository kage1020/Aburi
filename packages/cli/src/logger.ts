import type { Logger } from "@aburi/types"
import type { LogLevel } from "./env"

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LoggerOptions {
  minimum?: LogLevel
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
