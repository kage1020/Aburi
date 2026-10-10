export type CliErrorCode =
  /** Bad CLI argument or missing required flag. Maps to exit 2. */
  | "input-error"
  /** Config or IR shape violation surfaced from @aburi/config or @aburi/core. Maps to exit 2. */
  | "config-error"
  /** Runtime failure (IO, git, filesystem). Maps to exit 1. */
  | "runtime-error"
  /** Plugin load / manifest / strict-mode violation. Maps to exit 3. */
  | "plugin-error"

export class CliError extends Error {
  readonly code: CliErrorCode
  constructor(message: string, code: CliErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CliError"
    this.code = code
  }
}

/** The human-readable half of a thrown value, for a message that wraps it. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

export function internalFault(phase: string, detail: string, cause: unknown): CliError {
  return new CliError(
    `Internal error${phase}: ${detail}\n` +
      "This is a bug in Aburi, not in your configuration — please report it at " +
      "https://github.com/kage1020/Aburi/issues.",
    "runtime-error",
    { cause },
  )
}

export function unplacedErrorCode(
  phase: string,
  kind: string,
  error: { message: string },
  code: never,
): CliError {
  return internalFault(
    phase,
    `${error.message} (${kind} error code ${JSON.stringify(code)} has no exit code)`,
    error,
  )
}

export function assertNever(value: never, subject: string): never {
  throw new CliError(`Unhandled ${subject}: ${JSON.stringify(value)}`, "runtime-error")
}
