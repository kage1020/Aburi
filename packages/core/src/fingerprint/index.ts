import type { Fingerprint, Symbol as IRSymbol } from "@aburi/types"
import { apiFingerprint } from "./api"
import { ZERO_FINGERPRINT } from "./hash"
import { logicFingerprint } from "./logic"
import { syntaxFingerprint } from "./syntax"

export { apiFingerprint } from "./api"
export { hashCanonicalObject, hashRawString, ZERO_FINGERPRINT } from "./hash"
export { logicFingerprint } from "./logic"
export { lastQnameSegment } from "./short-name"
export { normalizeFingerprintString } from "./string"
export { syntaxFingerprint } from "./syntax"

export interface ComputeFingerprintOptions {
  /**
   * Language-plugin-provided normalized AST string for the Symbol body. Required for
   * non-dropped Symbols because the syntax axis cannot be derived without it. Dropped
   * Symbols ignore this input and receive the ZERO fingerprint on every axis.
   */
  normalizedAstString?: string
}

/**
 * Compute all three fingerprint axes for a Symbol.
 *
 * Dropped Symbols (`Symbol.dropped === true`) short-circuit to the ZERO fingerprint on
 * every axis so cross-IR comparisons treat them as unchanged and diff reports skip them.
 * Non-dropped Symbols require the caller to supply the normalized AST string — the syntax
 * axis is language-plugin-owned and this function cannot synthesize it.
 */
export function computeSymbolFingerprint(
  symbol: IRSymbol,
  options: ComputeFingerprintOptions = {},
): Fingerprint {
  if (symbol.dropped) {
    return { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT }
  }
  return {
    api: apiFingerprint(symbol),
    logic: logicFingerprint(symbol),
    syntax: syntaxFingerprint(options.normalizedAstString ?? ""),
  }
}
