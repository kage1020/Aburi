import type { Fingerprint, Symbol as IRSymbol } from "@aburi/types"
import { CoreError } from "../errors"
import { apiFingerprint } from "./api"
import { ZERO_FINGERPRINT } from "./hash"
import { logicFingerprint } from "./logic"
import { syntaxFingerprint } from "./syntax"

export { apiFingerprint } from "./api"
export { FP_HEX_LENGTH, hashCanonicalObject, hashRawString, ZERO_FINGERPRINT } from "./hash"
export { logicFingerprint, logicNamesNothing } from "./logic"
export { lastQnameSegment } from "./short-name"
export { normalizeFingerprintString } from "./string"
export { syntaxFingerprint } from "./syntax"

export interface ComputeFingerprintInput {
  symbol: IRSymbol
  normalizedAstString?: string
}

export function computeSymbolFingerprint(input: ComputeFingerprintInput): Fingerprint {
  if (input.symbol.dropped) {
    return { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT }
  }
  if (input.normalizedAstString === undefined) {
    throw new CoreError(
      `computeSymbolFingerprint requires normalizedAstString for the non-dropped Symbol "${input.symbol.id}"; a missing string would collapse the syntax axis to a shared hash across every AST-less Symbol`,
      { code: "non-plain-json", value: input.symbol.id },
    )
  }
  return {
    api: apiFingerprint(input.symbol),
    logic: logicFingerprint(input.symbol),
    syntax: syntaxFingerprint(input.normalizedAstString),
  }
}
