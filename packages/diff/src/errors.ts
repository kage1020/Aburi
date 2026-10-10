import type { IntegrityViolation } from "@aburi/core"

export type DiffErrorCode =
  | "schema-mismatch"
  | "invalid-line-fuzz"
  | "ir-shape-invalid"
  | "ir-identity-collision"
  | "slice-invariant-violated"

export interface DiffErrorDetail {
  code: DiffErrorCode
  value?: string
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
