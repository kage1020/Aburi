/**
 * Coded error class for every registry failure. Consumers can branch on `code`
 * without parsing message text. See design/details/extension-vocab.md §5
 * (namespaces) and §6 (conflicts) for the underlying rules; `manifest-*` codes are
 * I/O / parse / schema failures that surface before the registry sees the manifest.
 *
 * `plugins[]` carries 0, 1, or 2 names:
 *   - 0: failure occurred before the manifest could be identified (file read, JSON
 *        parse before any structure was recovered).
 *   - 1: single-plugin failure (reserved namespace, xPrefix mismatch, etc.).
 *   - 2: cross-plugin conflict (duplicate id, prefix overlap, etc.). The first
 *        entry is the existing owner; the second is the manifest that triggered
 *        the conflict.
 */

export type RegistryErrorCode =
  /** Filesystem failure while reading the manifest file (ENOENT, EACCES, EIO, etc.). */
  | "manifest-read-failed"
  /** Manifest file is not valid JSONC (lexical error). */
  | "manifest-parse-failed"
  /** Manifest does not conform to aburi.plugin.v1.json or contains non-JSON values. */
  | "manifest-invalid"
  /** Manifest references a reserved namespace (core / aburi / _ / framework:hint). */
  | "reserved-namespace"
  /** Effects manifest's xPrefix does not match its declared effect ids/prefixes. */
  | "xprefix-mismatch"
  /** Plugin declares vocab outside the namespaces allowed for its `type`. */
  | "namespace-type-mismatch"
  /** Two plugins declare the same id (effect / extKind) or framework name. */
  | "duplicate-id"
  /** Two plugins declare the same prefix (effect / extKind). */
  | "duplicate-prefix"
  /** A prefix in one plugin shadows or is shadowed by an id in another. */
  | "prefix-shadow-id"
  /** Two plugins' prefixes contain each other (one is a strict prefix of the other). */
  | "prefix-prefix-overlap"
  /** Two plugins' derivedByPrefixes overlap. */
  | "derivedby-prefix-overlap"
  /** Two plugins with the same name were registered with non-identical manifests. */
  | "name-collision"
  /** assertEffectDeclared / assertExtKindDeclared called for an unowned or wrong-owner id. */
  | "vocab-undeclared"

export interface RegistryErrorDetail {
  code: RegistryErrorCode
  /**
   * Plugin name(s) at fault. May be empty (pre-identification failures),
   * length 1 (single-plugin failures), or length 2 (cross-plugin conflicts:
   * [existing-owner, new-arrival]).
   */
  plugins: readonly string[]
  /** Offending value (id, prefix, framework name) when applicable. */
  value?: string
}

export class RegistryError extends Error {
  readonly code: RegistryErrorCode
  readonly plugins: readonly string[]
  readonly value: string | undefined

  constructor(message: string, detail: RegistryErrorDetail, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RegistryError"
    this.code = detail.code
    this.plugins = detail.plugins
    this.value = detail.value
  }
}
