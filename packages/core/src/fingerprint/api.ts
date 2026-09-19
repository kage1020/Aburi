import type { Decorator, Symbol as IRSymbol, Signature } from "@aburi/types"
import { compareCodeUnit } from "../order"
import { hashCanonicalObject } from "./hash"
import { lastQnameSegment } from "./short-name"
import { normalizeFingerprintString } from "./string"

/**
 * Shape of the api fingerprint input. Locked to keep the SHA-256 input stable across
 * releases: adding a field is a breaking change to every previously-computed api hash,
 * so any addition must ship with a schema version bump.
 */
interface ApiInput {
  decorators: Array<{ name: string; raw: string; boundary: boolean }>
  extKind: string | null
  kind: string
  shortName: string
  signature: {
    async: boolean
    generator: boolean
    inputs: Array<{ type: string }>
    outputs: string[]
    throws: string[]
    typeParameters: string[]
  } | null
  visibility: string
}

/**
 * Compute the api axis for a single Symbol: the externally observable contract, which is
 * every `ApiInput` field above. The axis intentionally excludes:
 *   - Symbol.language (the id already carries `<lang>:` and the language cannot change for
 *     a given id in practice)
 *   - Symbol.name's class-scope prefix (only the short name, so a class rename does not
 *     perturb every method's api)
 *   - the parameter names of the signature (they are not part of the caller-visible contract
 *     in most languages we care about)
 *   - anything from rules / effects / calls (those are the logic axis's job)
 */
export function apiFingerprint(symbol: IRSymbol): string {
  return hashCanonicalObject(buildApiInput(symbol))
}

function buildApiInput(symbol: IRSymbol): ApiInput {
  return {
    decorators: canonicalizeDecorators(symbol.decorators),
    extKind: symbol.extKind ?? null,
    kind: symbol.kind,
    shortName: lastQnameSegment(symbol.name),
    signature: canonicalizeSignature(symbol.signature ?? null),
    visibility: symbol.visibility,
  }
}

/**
 * Sort decorators by (name, line) so any two symbols with the same declared set produce
 * the same hash regardless of source order. Line breaks the tie so two decorators with
 * the same name (e.g. multiple `@ApiResponse(...)` calls) still order deterministically.
 * The raw string is canonicalized (NFC + whitespace collapse) so a reformat does not
 * perturb the hash.
 */
function canonicalizeDecorators(
  decorators: readonly Decorator[],
): Array<{ name: string; raw: string; boundary: boolean }> {
  return [...decorators]
    .sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1
      return a.line - b.line
    })
    .map((d) => ({
      name: d.name,
      raw: normalizeFingerprintString(d.raw),
      boundary: d.boundary,
    }))
}

function canonicalizeSignature(signature: Signature | null): ApiInput["signature"] {
  if (signature === null) return null
  return {
    async: signature.async,
    generator: signature.generator,
    inputs: signature.inputs.map((i) => ({ type: normalizeFingerprintString(i.type) })),
    outputs: signature.outputs.map(normalizeFingerprintString),
    // throws are compared as a set — swapping their order in source should not register
    // as an api change. Sort by code unit for determinism.
    throws: [...signature.throws].map(normalizeFingerprintString).sort(compareCodeUnit),
    typeParameters: signature.typeParameters.map(normalizeFingerprintString),
  }
}
