/**
 * Coded error class for every config failure. Consumers branch on `code` without
 * parsing message text. See design/details/config.md §14 for the underlying rules.
 */

export type ConfigErrorCode =
  /** Filesystem failure while reading aburi.json/aburi.jsonc (ENOENT, EACCES, EIO, ...). */
  | "config-read-failed"
  /** Config file is not valid JSONC (lexical error). */
  | "config-parse-failed"
  /** Config does not conform to aburi.config.v1.json or contains non-JSON values. */
  | "config-invalid"
  /** components[] declares the same id more than once (C4). */
  | "duplicate-component-id"
  /** frameworkHints[] declares the same name more than once (C6). */
  | "duplicate-hint-name"
  /**
   * User wrote extKind/derivedBy under the reserved `framework:hint:*` / `framework-hint:*`
   * namespace directly. hint: is auto-prefixed by the loader; writing it explicitly is rejected
   * to avoid double-prefixing and namespace shadowing (config.md §8.3.1).
   */
  | "reserved-namespace"

export interface ConfigErrorDetail {
  code: ConfigErrorCode
  /** Offending value (id, name, extKind, derivedBy) when applicable. */
  value?: string
}

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
