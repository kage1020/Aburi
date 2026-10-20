import type { Signature } from "@aburi/types"
import { mean, NONE, quotient, type Ratio, WHOLE } from "./ratio"
import { jaccardRatio } from "./similarity"

export function signatureSimilarity(
  base: Signature | null | undefined,
  head: Signature | null | undefined,
): number {
  return quotient(signatureSimilarityRatio(base, head))
}

export function signatureSimilarityRatio(
  base: Signature | null | undefined,
  head: Signature | null | undefined,
): Ratio {
  const baseSig = base ?? null
  const headSig = head ?? null
  if (baseSig === null && headSig === null) return WHOLE
  if (baseSig === null || headSig === null) return NONE
  const inputsScore = compareOrderedTypes(
    baseSig.inputs.map((input) => input.type),
    headSig.inputs.map((input) => input.type),
  )
  const outputsScore = compareOrderedTypes(baseSig.outputs, headSig.outputs)
  const throwsScore = jaccardRatio(baseSig.throws, headSig.throws)
  return mean([inputsScore, outputsScore, throwsScore])
}

function compareOrderedTypes(a: readonly string[], b: readonly string[]): Ratio {
  if (a.length === 0 && b.length === 0) return WHOLE
  if (a.length !== b.length) return NONE
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++
  }
  return { numerator: matches, denominator: a.length }
}
