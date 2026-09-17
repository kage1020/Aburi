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

/** The human-readable half of a thrown value, for a message that wraps it. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The `code` a thrown value carries, or `null` when it carries none. Callers differ only in
 * which codes they act on — an errno set, a `commander.` prefix — not in how one is read.
 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

/**
 * The report for a failure that is Aburi's own rather than the reader's.
 *
 * `phase` names what was under way (`"while loading the Aburi config"`), or is empty for a
 * bare `Internal error:`. The instruction sits on its own line because nothing that reaches
 * here ends in punctuation: a thrown message run together with the next sentence is what a
 * reader has to unpick.
 */
export function internalFault(phase: string, detail: string, cause: unknown): CliError {
  return new CliError(
    `Internal error${phase}: ${detail}\n` +
      "This is a bug in Aburi, not in your configuration — please report it at " +
      "https://github.com/kage1020/Aburi/issues.",
    "runtime-error",
    { cause },
  )
}

/**
 * The `default:` arm of an exhaustive switch over an upstream error code.
 *
 * A new code is a type error here rather than one that silently takes an arm — and at
 * runtime it degrades to an internal fault instead of throwing, because the compile-time
 * check protects this repo's build and not an installed tree: `@aburi/config` and
 * `@aburi/diff` version independently of this package, so a compiled switch can meet a code
 * it never saw. Throwing there would discard the one thing the reader needs, which is what
 * the upstream error said.
 */
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

/**
 * Compile-time exhaustiveness guard: a new union member is a type error at the call site
 * rather than a branch that silently does nothing. Exit 1 at runtime, like any other bug.
 */
export function assertNever(value: never, subject: string): never {
  throw new CliError(`Unhandled ${subject}: ${JSON.stringify(value)}`, "runtime-error")
}
