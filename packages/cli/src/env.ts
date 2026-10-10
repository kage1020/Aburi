export interface AburiEnv {
  configPath: string | null
  logLevel: LogLevel | null
  noColor: boolean
  forceColor: boolean
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
