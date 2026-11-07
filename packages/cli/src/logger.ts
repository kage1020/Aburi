import type { Logger } from "@aburi/types"
import type { LogLevel } from "./env"

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** Where a `Logger` line goes: the line ends in a newline, and `level` is the one it was logged at. */
export type LogWrite = (line: string, level: LogLevel) => void

export interface LoggerOptions {
  minimum?: LogLevel
  write?: LogWrite
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVEL_RANK[options.minimum ?? "warn"]
  const write = options.write ?? writeToStderr
  const at =
    (level: LogLevel) =>
    (message: string): void => {
      if (LOG_LEVEL_RANK[level] < threshold) return
      write(`${level}: ${message}\n`, level)
    }
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  }
}

export function writeToStderr(line: string): void {
  process.stderr.write(line)
}
