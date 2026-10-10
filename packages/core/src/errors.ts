export type CoreErrorCode =
  /** An attempt to create a Symbol id whose qualified name names an anonymous construct. */
  | "anonymous-symbol-id-attempted"
  /** A path was passed that contains a backslash, an absolute prefix, or `..` ascent. */
  | "non-posix-path"
  /** A language id failed the lowercase ASCII pattern required by the IR schema, or named a reserved namespace. */
  | "invalid-language-id"
  /** A Component id failed the ASCII kebab-case pattern required by the IR schema. */
  | "invalid-component-id"
  | "component-id-collision-unresolved"
  /** serializeCanonical encountered a value JSON cannot represent (function, symbol, bigint, …). */
  | "non-plain-json"
  | "canonical-key-collision"
  /** An id part was not in Unicode NFC; ids are normalized at construction so both forms match. */
  | "invalid-symbol-id"
  /** One or more of the IR invariants in ir-schema.md were violated; `details` carries each violation. */
  | "integrity-violation"
  /** Workspace root detection failed (no marker found between cwd and filesystem root). */
  | "workspace-root-not-found"
  /** A workspace manager manifest could not be parsed (malformed YAML / JSON). */
  | "workspace-manifest-malformed"
  /** A workspace manager manifest declared a package outside the workspace root, which no IR path can name. */
  | "workspace-root-outside"
  /** Two language plugins claim the same file extension — a plugin-registry misconfiguration. */
  | "language-routing-collision"
  | "scan-plugin-misconfigured"
  | "scan-gitignore-unreadable"
  /** `ScanInput.workspaceRoot` was not an absolute path; scan cannot resolve files reliably. */
  | "scan-workspace-not-absolute"
  /** The effect-propagation pass observed an internal-invariant violation (e.g. an edge referencing a Symbol not in the input, an unreachable branch executing). */
  | "propagation-invariant-violated"
  /** LSP enrichment received a config the schema should have rejected (e.g. missing `command` after we already dereferenced it). Never reaches users when config-load validation is in place. */
  | "lsp-config-invalid"
  | "scan-outcome-unhandled"
  | "receiver-hint-key-malformed"
  | "vocab-undeclared"

export interface IntegrityViolation {
  /** Stable invariant id corresponding to the ir-schema.md numbering, which is the single source of the list. */
  invariant: number
  /** Identifier (Symbol id, Component id, file path, etc.) the violation is attributed to. */
  subject: string
  /** Human-readable explanation of what failed. */
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
