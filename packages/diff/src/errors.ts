/**
 * Coded error class for every @aburi/diff failure. Consumers branch on `code` without
 * parsing message text. Codes are stable and additions are non-breaking; renames are not.
 */

import type { IntegrityViolation } from "@aburi/core"

export type DiffErrorCode =
  /** `base.$schema` and `head.$schema` disagree; a diff across schema versions cannot be trusted (§9.1). */
  | "schema-mismatch"
  /** `config.diff.lineFuzz` was outside the documented [0, 10] range (diff-algorithm.md §5.2.1). */
  | "invalid-line-fuzz"
  /**
   * `baseIR` or `headIR` is not a Document of the shape `aburi.ir.v1` requires. `buildDiff`
   * establishes that before touching any Symbol, by running invariant #20
   * (`checkDocumentShape`): every field the schema requires, at every depth, named by the
   * record it sits in and the field inside it — so a missing `stats` or `workspace`, a
   * `symbols[3]` with no `fingerprint`, and a `stats.effectPropagation` with no `sccCount`
   * all raise this. Anything here would otherwise crash during classification or the delta
   * with a `TypeError` naming neither the record nor the field.
   *
   * A non-empty `$schema` is raised under this code too. That one is `buildDiff`'s own
   * requirement rather than the schema's — two Documents that both say `""` agree with each
   * other, so `schema-mismatch` would never fire on the pair.
   *
   * Not the semantic invariants: those are statements about a Document whose answer the diff
   * does not depend on, and refusing an unsorted `symbols[]` would withhold a diff the
   * matcher can produce.
   */
  | "ir-shape-invalid"
  /**
   * `baseIR` or `headIR` repeats an identity the diff keys on: a `symbols[].id`, a
   * `components[].id`, or a `dependencies[]` `(from, to, via)` triple. Distinct from
   * `ir-shape-invalid` because the Document is well-formed — the collision changes the
   * answer rather than preventing one, and ir-schema.md §14 #1 / #2 / #13 already forbid it.
   */
  | "ir-identity-collision"
  /**
   * A `SliceRecord` broke the derivation invariant of slice-view.md §7.1 / §8.2:
   * `members[]` empty, `members[]` not in strictly ascending order, or `id` not
   * equal to `"slice:" + members[0]`. The last two compare one property against
   * another and so have no JSON Schema equivalent; the pass checks them itself
   * (§7.4). Raised only by an Aburi bug, never by user input — see
   * `SliceRecordViolation.kind` for which clause broke.
   */
  | "slice-invariant-violated"

export interface DiffErrorDetail {
  code: DiffErrorCode
  /** Offending value (schema id, fuzz value, etc.) when applicable. */
  value?: string
  /**
   * Populated only for `ir-shape-invalid`, one entry per breach of invariant #20.
   *
   * The message quotes the first and counts the rest, which is enough to start on and not
   * enough to finish: a caller fixing a hand-assembled Document needs the others without
   * running the diff again per field. `CoreErrorDetail.violations` carries the same array
   * for the same reason, and the two are the same `IntegrityViolation` type.
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
