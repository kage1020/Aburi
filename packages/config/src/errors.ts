/**
 * Coded error class for every config failure. Consumers branch on `code` without parsing
 * message text; structured `cause` and per-code `value` carry the underlying diagnostic
 * (JSONC parse offsets, ajv validation params, offending id/name) so log shippers and IDE
 * integrations can render rich errors without re-parsing the message.
 */

/** Failures with no semantically meaningful value: source path / cause already carry the context. */
export type ContextFreeConfigErrorCode =
  /** Filesystem failure while reading or probing aburi.json/aburi.jsonc (EACCES, EIO, …). ENOENT/ENOTDIR are not errors. */
  | "config-read-failed"
  /** Config file is not valid JSONC (lexical error). */
  | "config-parse-failed"
  /** Config does not conform to aburi.config.v1.json or contains non-JSON values. */
  | "config-invalid"

/** Failures attributable to a specific user-written string: `value` is required. */
export type ValuedConfigErrorCode =
  /** components[] declares the same id more than once. */
  | "duplicate-component-id"
  /** frameworkHints[] declares the same name more than once. */
  | "duplicate-hint-name"
  /**
   * User wrote extKind under the reserved `framework:hint:*` namespace directly; the loader
   * auto-injects "hint" and the explicit form would double-prefix or shadow another hint.
   */
  | "reserved-namespace"

export type ConfigErrorCode = ContextFreeConfigErrorCode | ValuedConfigErrorCode

/**
 * Discriminated union: `value` is required exactly when `code` names a single offending
 * string, and forbidden otherwise. The compiler now refuses errors that forget to attribute
 * a duplicate id and refuses errors that attribute one to a read failure.
 */
export type ConfigErrorDetail =
  | { code: ContextFreeConfigErrorCode; value?: undefined }
  | { code: ValuedConfigErrorCode; value: string }

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
