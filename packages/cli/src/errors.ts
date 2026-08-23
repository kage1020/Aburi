/**
 * CLI-level error class. Reserved for failures that surface as human-facing messages —
 * anything downstream (@aburi/config, @aburi/core, plugin load errors) either re-throws
 * with an already-suitable message or the CLI wraps them in a CliError so the exit-code
 * table stays consistent.
 */
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

/**
 * The human-readable half of a thrown value, for a message that wraps it.
 *
 * Beside `CliError` because every caller is building one: six modules held a byte-identical
 * copy of these two lines, which is one definition of "what a caught value looks like in a
 * CLI message" written six times.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
