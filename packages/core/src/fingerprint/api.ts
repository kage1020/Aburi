import type { Decorator, Symbol as IRSymbol, Signature } from "@aburi/types"
import { compareCodeUnit } from "../order"
import { hashCanonicalObject } from "./hash"
import { lastQnameSegment } from "./short-name"
import { normalizeFingerprintString } from "./string"

/**
 * Shape of the api fingerprint input (fingerprint.md §3.1). The hash is compared against IRs
 * earlier releases wrote, so a key added here must be absent wherever it has nothing to say:
 * the canonical serializer drops an absent key, and a Symbol that does not carry it then
 * hashes to the bytes it always did. A key present on every Symbol would move every api hash
 * at once. The two parameter markers are of the first kind — Class B fields (ir-schema.md
 * §1.1), written only when `true` — so only a parameter that carries one hashes differently.
 */
interface ApiInput {
  decorators: Array<{ name: string; raw: string; boundary: boolean }>
  extKind: string | null
  kind: string
  shortName: string
  signature: {
    async: boolean
    generator: boolean
    inputs: ApiParameter[]
    outputs: string[]
    throws: string[]
    typeParameters: string[]
  } | null
  visibility: string
}

/** One parameter as the api axis sees it: everything about it a caller writes against. */
interface ApiParameter {
  type: string
  optional?: true
  rest?: true
}

/**
 * Compute the api axis for a single Symbol: the externally observable contract, which is
 * every `ApiInput` field above. The axis intentionally excludes:
 *   - Symbol.language (the id already carries `<lang>:` and the language cannot change for
 *     a given id in practice)
 *   - Symbol.name's class-scope prefix (only the short name, so a class rename does not
 *     perturb every method's api)
 *   - the parameter names of the signature (they are not part of the caller-visible contract
 *     in most languages we care about). What a caller does see of a parameter is kept: its
 *     type, and whether it may be omitted or collects the rest of the arguments
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
    inputs: signature.inputs.map(canonicalizeParameter),
    outputs: signature.outputs.map(normalizeFingerprintString),
    throws: [...signature.throws].map(normalizeFingerprintString).sort(compareCodeUnit),
    typeParameters: signature.typeParameters.map(normalizeFingerprintString),
  }
}

/**
 * A marker enters the hash only when it is `true`, so a parameter with neither serializes to
 * `{"type":…}` alone, byte for byte what a Document without the fields hashes. A `false` from
 * a producer that ignores the Class B rule says the same as absence and hashes the same.
 */
function canonicalizeParameter(input: Signature["inputs"][number]): ApiParameter {
  const out: ApiParameter = { type: normalizeFingerprintString(input.type) }
  if (input.optional === true) out.optional = true
  if (input.rest === true) out.rest = true
  return out
}
