/**
 * §11 — environment-variable → CLI-behaviour mapping. Kept pure so tests can inject a
 * frozen `env` bag rather than mutating `process.env`.
 */

export interface AburiEnv {
  /** Override config path (equivalent to --config). */
  configPath: string | null
  /** Log level override (equivalent to --log-level). */
  logLevel: LogLevel | null
  /** `NO_COLOR` (standard): any non-empty value disables ANSI. */
  noColor: boolean
  /** `FORCE_COLOR` (standard): any non-empty value forces ANSI even in non-TTY. */
  forceColor: boolean
  /** `CI` (standard): any non-empty value activates CI mode (no progress animations). */
  ci: boolean
}

export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"])

export function readEnv(source: NodeJS.ProcessEnv = process.env): AburiEnv {
  const configPath = nonEmpty(source.ABURI_CONFIG) ?? null
  const rawLevel = nonEmpty(source.ABURI_LOG_LEVEL)
  const logLevel =
    rawLevel !== undefined && LOG_LEVELS.has(rawLevel as LogLevel) ? (rawLevel as LogLevel) : null
  return {
    configPath,
    logLevel,
    noColor: hasValue(source.NO_COLOR),
    forceColor: hasValue(source.FORCE_COLOR),
    ci: hasValue(source.CI),
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function hasValue(value: string | undefined): boolean {
  return nonEmpty(value) !== undefined
}
