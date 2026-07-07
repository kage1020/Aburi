import type { Logger } from "@aburi/types"
import type { LogLevel } from "./env"

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface CreateLoggerOptions {
  level: LogLevel
  /** Stream used for warn/error lines. Default: process.stderr. */
  stderr?: NodeJS.WritableStream
  /** Stream used for debug/info lines. Default: process.stderr — stdout is reserved for results. */
  progressStream?: NodeJS.WritableStream
}

/**
 * §10 — stdout / stderr separation is a hard contract. Every logger channel routes to
 * `stderr` by default so `aburi scan --quiet | wc -l` and similar CI pipes work without
 * escaping. Callers pass `progressStream: process.stdout` if they explicitly want a
 * command result to land on stdout — the result printer, not this logger, owns stdout.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const stderr = options.stderr ?? process.stderr
  const progress = options.progressStream ?? process.stderr
  const threshold = LEVEL_RANK[options.level]
  const emit = (level: LogLevel, target: NodeJS.WritableStream, message: string): void => {
    if (LEVEL_RANK[level] < threshold) return
    target.write(`${message}\n`)
  }
  return {
    debug: (message: string) => emit("debug", progress, message),
    info: (message: string) => emit("info", progress, message),
    warn: (message: string) => emit("warn", stderr, `⚠ ${message}`),
    error: (message: string) => emit("error", stderr, `✗ ${message}`),
  }
}
