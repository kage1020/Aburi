export const MISSING_FILE_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

/** Failures whose source path / `cause` already carry the context: no `value`. */
export type ContextFreeConfigErrorCode =
  /** Filesystem refused a config that is there (EACCES, EIO, EISDIR, …). */
  | "config-read-failed"
  /** A config named explicitly is not there. Discovery answers absence with `null` instead. */
  | "config-not-found"
  /** Config file is not valid JSONC. */
  | "config-parse-failed"
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
