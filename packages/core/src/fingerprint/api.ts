import type { Decorator, Symbol as IRSymbol, Signature } from "@aburi/types"
import { compareCodeUnit } from "../order"
import { hashCanonicalObject } from "./hash"
import { lastQnameSegment } from "./short-name"
import { normalizeFingerprintString } from "./string"

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

function canonicalizeParameter(input: Signature["inputs"][number]): ApiParameter {
  const out: ApiParameter = { type: normalizeFingerprintString(input.type) }
  if (input.optional === true) out.optional = true
  if (input.rest === true) out.rest = true
  return out
}
