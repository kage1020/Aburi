/**
 * Errnos that mean there is nothing at that path, as opposed to something the filesystem
 * would not hand over. Shared so discovery ("keep walking") and an explicitly named path
 * (`config-not-found`) agree on which failures are an absence.
 */
export const MISSING_FILE_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

/** Failures whose source path / `cause` already carry the context: no `value`. */
export type ContextFreeConfigErrorCode =
  /** Filesystem refused a config that is there (EACCES, EIO, EISDIR, …). */
  | "config-read-failed"
  /** A config named explicitly is not there. Discovery answers absence with `null` instead. */
  | "config-not-found"
  /** Config file is not valid JSONC. */
  | "config-parse-failed"
  /** Config does not conform to aburi.config.v1.json or contains non-JSON values. */
  | "config-invalid"

/** Failures attributable to a specific user-written string: `value` is required. */
export type ValuedConfigErrorCode =
  /** components[] declares the same id more than once. */
  | "duplicate-component-id"
  /** frameworkHints[] declares the same name more than once. */
  | "duplicate-hint-name"
  /** extKind written under the reserved `framework:hint:*` namespace the loader injects. */
  | "reserved-namespace"

export type ConfigErrorCode = ContextFreeConfigErrorCode | ValuedConfigErrorCode

/** `value` is required exactly when `code` names a single offending string. */
export type ConfigErrorDetail =
  | { code: ContextFreeConfigErrorCode; value?: undefined }
  | { code: ValuedConfigErrorCode; value: string }

/**
 * Coded error for every config failure. Consumers branch on `code` rather than message
 * text; `cause` carries the structured diagnostic (JSONC parse errors, ajv errors, errno).
 */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode
  readonly value: string | undefined

  constructor(message: string, detail: ConfigErrorDetail, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ConfigError"
    this.code = detail.code
    this.value = detail.value
  }
}
