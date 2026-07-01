import type { Fingerprint, Symbol as IRSymbol } from "@aburi/types"
import { CoreError } from "../errors"
import { apiFingerprint } from "./api"
import { ZERO_FINGERPRINT } from "./hash"
import { logicFingerprint } from "./logic"
import { syntaxFingerprint } from "./syntax"

export { apiFingerprint } from "./api"
export { FP_HEX_LENGTH, hashCanonicalObject, hashRawString, ZERO_FINGERPRINT } from "./hash"
export { logicFingerprint } from "./logic"
export { lastQnameSegment } from "./short-name"
export { normalizeFingerprintString } from "./string"
export { syntaxFingerprint } from "./syntax"

export interface ComputeFingerprintInput {
  symbol: IRSymbol
  /**
   * Language-plugin-provided normalized AST string. Required when `symbol.dropped` is
   * false (a missing string would collapse the syntax axis to `SHA-256("")` for every
   * non-dropped Symbol). Ignored when `symbol.dropped` is true — dropped Symbols receive
   * the ZERO fingerprint on every axis regardless.
   *
   * Type-level discrimination on `Symbol.dropped` would be cleaner, but the IR schema
   * types `dropped` as plain `boolean`, so a compile-time narrow would collapse under
   * `exactOptionalPropertyTypes`. The runtime check below closes the same gap; the
   * secondary guard inside `syntaxFingerprint` closes it again for direct callers.
   */
  normalizedAstString?: string
}

/**
 * Compute all three fingerprint axes for a Symbol.
 *
 * Dropped Symbols receive the ZERO fingerprint on every axis so cross-IR comparisons treat
 * them as unchanged. Non-dropped Symbols require the caller to supply a non-empty
 * `normalizedAstString`; passing `undefined` or whitespace-only throws a `CoreError`
 * instead of silently collapsing every AST-less Symbol onto the same hash.
 */
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
