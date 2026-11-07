export interface AburiEnv {
  configPath: string | null
  logLevel: LogLevel | null
  noColor: boolean
  /** `FORCE_COLOR`: on, off (`0`, `false`), or not set. */
  forceColor: boolean | null
  /** `TERM=dumb`: a terminal that takes no cursor movement and no colour. */
  dumbTerminal: boolean
  ci: boolean
}

export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>(["debug", "info", "warn", "error"])

export function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.has(value)
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): AburiEnv {
  const configPath = nonEmpty(source.ABURI_CONFIG) ?? null
  const rawLevel = nonEmpty(source.ABURI_LOG_LEVEL)
  const logLevel = rawLevel !== undefined && isLogLevel(rawLevel) ? rawLevel : null
  return {
    configPath,
    logLevel,
    noColor: hasValue(source.NO_COLOR),
    forceColor: readForceColor(source.FORCE_COLOR),
    dumbTerminal: source.TERM?.trim() === "dumb",
    ci: hasValue(source.CI),
  }
}

// Node's reading: an empty value forces colour on, as `1` does.
function readForceColor(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const word = value.trim().toLowerCase()
  return word !== "0" && word !== "false"
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function hasValue(value: string | undefined): boolean {
  return nonEmpty(value) !== undefined
}
