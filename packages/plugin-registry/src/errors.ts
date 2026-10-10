export type RegistryErrorCode =
  /** Filesystem failure while reading the manifest file (ENOENT, EACCES, EIO, etc.). */
  | "manifest-read-failed"
  /** Manifest file is not valid JSONC (lexical error). */
  | "manifest-parse-failed"
  | "manifest-invalid"
  /** Manifest references a reserved namespace (core / aburi / _ / framework:hint). */
  | "reserved-namespace"
  /** Effects manifest's xPrefix does not match its declared effect ids/prefixes. */
  | "xprefix-mismatch"
  /** Plugin declares vocab outside the namespaces allowed for its `type`. */
  | "namespace-type-mismatch"
  | "duplicate-id"
  /** Two plugins declare the same prefix (effect / extKind / derivedBy). */
  | "duplicate-prefix"
  /** A prefix in one plugin shadows or is shadowed by an id in another. */
  | "prefix-shadow-id"
  | "prefix-prefix-overlap"
  /** Two derivedByPrefixes nest, the same way and with the same one-plugin case. */
  | "derivedby-prefix-overlap"
  /** Two plugins with the same name were registered with non-identical manifests. */
  | "name-collision"
  /** assertEffectDeclared / assertExtKindDeclared called for an unowned or wrong-owner id. */
  | "vocab-undeclared"

export interface RegistryErrorDetail {
  code: RegistryErrorCode
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
