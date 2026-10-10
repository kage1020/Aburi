export type CoreErrorCode =
  | "anonymous-symbol-id-attempted"
  | "non-posix-path"
  | "invalid-language-id"
  | "invalid-component-id"
  | "component-id-collision-unresolved"
  | "non-plain-json"
  | "canonical-key-collision"
  | "invalid-symbol-id"
  | "integrity-violation"
  | "workspace-root-not-found"
  | "workspace-manifest-malformed"
  | "workspace-root-outside"
  | "language-routing-collision"
  | "scan-plugin-misconfigured"
  | "scan-gitignore-unreadable"
  | "scan-workspace-not-absolute"
  | "propagation-invariant-violated"
  | "lsp-config-invalid"
  | "scan-outcome-unhandled"
  | "receiver-hint-key-malformed"
  | "vocab-undeclared"

export interface IntegrityViolation {
  invariant: number
  /** Identifier (Symbol id, Component id, file path, etc.) the violation is attributed to. */
  subject: string
  message: string
}

export interface CoreErrorDetail {
  code: CoreErrorCode
  /** Offending value (path, id, language token) when applicable. */
  value?: string
  /** Populated only for "integrity-violation"; one entry per invariant breach. */
  violations?: readonly IntegrityViolation[]
}

export class CoreError extends Error {
  readonly code: CoreErrorCode
  readonly value: string | undefined
  readonly violations: readonly IntegrityViolation[] | undefined

  constructor(message: string, detail: CoreErrorDetail, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CoreError"
    this.code = detail.code
    this.value = detail.value
    this.violations = detail.violations
  }
}
