/**
 * Coded error class for every @aburi/diff failure. Consumers branch on `code` without
 * parsing message text. Codes are stable and additions are non-breaking; renames are not.
 */

import type { IntegrityViolation } from "@aburi/core"

export type DiffErrorCode =
  /** `base.$schema` and `head.$schema` disagree (diff-algorithm.md). */
  | "schema-mismatch"
  /** `config.diff.lineFuzz` was outside the documented [0, 10] range (diff-algorithm.md). */
  | "invalid-line-fuzz"
  /**
   * `baseIR` or `headIR` is not a Document of the shape `aburi.ir.v1` requires (invariant #20,
   * `checkDocumentShape`), or its `$schema` is empty. Not the semantic invariants — see
   * `assertDiffable`.
   */
  | "ir-shape-invalid"
  /**
   * `baseIR` or `headIR` repeats an identity the diff keys on: a `symbols[].id`, a
   * `components[].id`, or a `dependencies[]` `(from, to, via)` triple. Distinct from
   * `ir-shape-invalid` because the Document is well-formed — the collision changes the
   * answer rather than preventing one (ir-schema.md #1 / #2 / #13).
   */
  | "ir-identity-collision"
  /**
   * A `SliceRecord` broke the derivation invariant of slice-view.md. Raised only by
   * an Aburi bug, never by user input — see `SliceRecordViolation.kind` for which clause broke.
   */
  | "slice-invariant-violated"

export interface DiffErrorDetail {
  code: DiffErrorCode
  /** Offending value (schema id, fuzz value, etc.) when applicable. */
  value?: string
  /**
   * Populated only for `ir-shape-invalid`, one entry per breach of invariant #20, so a caller
   * repairing a hand-assembled Document sees every breach rather than the first.
   */
  violations?: readonly IntegrityViolation[]
}

export class DiffError extends Error {
  readonly code: DiffErrorCode
  readonly value: string | undefined
  readonly violations: readonly IntegrityViolation[] | undefined

  constructor(message: string, detail: DiffErrorDetail, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DiffError"
    this.code = detail.code
    this.value = detail.value
    this.violations = detail.violations
  }
}
