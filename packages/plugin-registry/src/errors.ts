/**
 * Coded error class for every registry failure. Consumers can branch on `code`
 * without parsing message text. See design/details/extension-vocab.md §6 for the
 * error catalogue. `plugin` carries the offending plugin's manifest name (or both
 * names for cross-plugin conflicts) so error messages can attribute blame.
 */

export type RegistryErrorCode =
  /** Generic schema validation failure (ajv). */
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
  /** A plugin uses two derivedByPrefixes that overlap with another plugin's. */
  | "derivedby-prefix-overlap"
  /** Two plugins with the same name were registered with non-identical manifests. */
  | "name-collision"
  /** assertEffectDeclared / assertExtKindDeclared called for an unowned or wrong-owner id. */
  | "vocab-undeclared"

export interface RegistryErrorDetail {
  code: RegistryErrorCode
  /** Plugin name(s) at fault. Two names for cross-plugin conflicts. */
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
