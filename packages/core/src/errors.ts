/**
 * Coded error class for every @aburi/core failure. Consumers branch on `code` without
 * parsing message text. Codes are stable and additions are non-breaking; renames are not.
 */

export type CoreErrorCode =
  /** An attempt to create a Symbol id whose qualified name names an anonymous construct. */
  | "anonymous-symbol-id-attempted"
  /** A path was passed that contains a backslash, an absolute prefix, or `..` ascent. */
  | "non-posix-path"
  /** A language id failed the lowercase ASCII pattern required by the IR schema, or named a reserved namespace. */
  | "invalid-language-id"
  /** A Component id failed the ASCII kebab-case pattern required by the IR schema. */
  | "invalid-component-id"
  /** serializeCanonical encountered a value JSON cannot represent (function, symbol, bigint, …). */
  | "non-plain-json"
  /**
   * Two object keys were distinct strings but identical after Unicode NFC normalization, so
   * writing both would lose one on read-back. Distinct from `non-plain-json`: each key is
   * perfectly representable, and it is their coexistence that is not.
   */
  | "canonical-key-collision"
  /** An id part was not in Unicode NFC; ids are normalized at construction so both forms match. */
  | "invalid-symbol-id"
  /** One or more of the IR invariants in ir-schema.md §14 were violated; `details` carries each violation. */
  | "integrity-violation"
  /** Workspace root detection failed (no marker found between cwd and filesystem root). */
  | "workspace-root-not-found"
  /** A workspace manager manifest could not be parsed (malformed YAML / JSON). */
  | "workspace-manifest-malformed"
  /** A workspace manager manifest declared a package outside the workspace root, which no IR path can name. */
  | "workspace-root-outside"
  /** Two language plugins claim the same file extension — a plugin-registry misconfiguration. */
  | "language-routing-collision"
  /**
   * A plugin violated its own interface in a way that is a property of the plugin rather
   * than of any one file — an effect plugin returning a Promise from the synchronous
   * `classify`, a language plugin emitting Symbol ids with no language prefix. Raised from
   * inside the per-file path, and the one code `scan()`'s per-file exception boundary
   * re-throws instead of absorbing (`lang-plugin.md` §7.2): the fault repeats for every
   * file, so withdrawing files one at a time would report the workspace as broken instead
   * of the plugin.
   */
  | "scan-plugin-misconfigured"
  /** A `.gitignore` — the workspace root's or any nested one — exists as a regular file and could not be used: an I/O error, a permission, or a line no regex engine will compile, which is reported against the line that holds it. A name that is not a regular file is not a rule file, and neither is a missing one; both are silently no patterns, as they are to git. */
  | "scan-gitignore-unreadable"
  /** `ScanInput.workspaceRoot` was not an absolute path; scan cannot resolve files reliably. */
  | "scan-workspace-not-absolute"
  /** The effect-propagation pass observed an internal-invariant violation (e.g. an edge referencing a Symbol not in the input, an unreachable branch executing). */
  | "propagation-invariant-violated"
  /** LSP enrichment received a config the schema should have rejected (e.g. missing `command` after we already dereferenced it). Never reaches users when config-load validation is in place. */
  | "lsp-config-invalid"
  /**
   * The per-file pipeline reported an outcome the scan has no branch for. Unreachable by
   * construction — the switch that raises it is exhaustive over `FilePipelineResult`,
   * enforced by a `never` parameter, so a new member is a compile error first. The code
   * exists so that the guard has something to say if it is ever reached anyway, rather than
   * a file quietly reaching neither the IR nor the skip list.
   */
  | "scan-outcome-unhandled"
  /**
   * `ResolveCallGraphInput.receiverHints` was non-empty and keyed by something other than
   * `makeCallSiteKey`. Raised rather than ignored because the failure is otherwise invisible:
   * every lookup misses, so the LSP tier contributes nothing and the run looks exactly like
   * one where the language server had nothing to say. The keys carried `${file}:${line}` up
   * to @aburi/core 0.3.0; they carry `makeCallSiteKey(file, line, target)` from 0.4.0.
   */
  | "receiver-hint-key-malformed"

export interface IntegrityViolation {
  /** Stable invariant id corresponding to the ir-schema.md §14 numbering, which is the single source of the list. */
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
