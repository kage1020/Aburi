/**
 * Coded error class for every @aburi/diff failure. Consumers branch on `code` without
 * parsing message text. Codes are stable and additions are non-breaking; renames are not.
 */

export type DiffErrorCode =
  /** `base.$schema` and `head.$schema` disagree; a diff across schema versions cannot be trusted (§9.1). */
  | "schema-mismatch"
  /** `config.diff.lineFuzz` was outside the documented [0, 10] range (diff-algorithm.md §5.2.1). */
  | "invalid-line-fuzz"

export interface DiffErrorDetail {
  code: DiffErrorCode
  /** Offending value (schema id, fuzz value, etc.) when applicable. */
  value?: string
}

export class DiffError extends Error {
  readonly code: DiffErrorCode
  readonly value: string | undefined

  constructor(message: string, detail: DiffErrorDetail, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DiffError"
    this.code = detail.code
    this.value = detail.value
  }
}
