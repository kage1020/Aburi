import type { Signature } from "@aburi/types"
import { jaccard } from "./similarity"

/**
 * signatureSimilarity (diff-algorithm.md) — mean of three subscores over `inputs` (ordered
 * type equality rate), `outputs` (same) and `throws` (Jaccard). Two null signatures score
 * 1.0, one null scores 0.0. Empty on both sides counts as 1.0, empty on one side as 0.0.
 */
export function signatureSimilarity(
  base: Signature | null | undefined,
  head: Signature | null | undefined,
): number {
  const baseSig = base ?? null
  const headSig = head ?? null
  if (baseSig === null && headSig === null) return 1
  if (baseSig === null || headSig === null) return 0
  const inputsScore = compareOrderedTypes(
    baseSig.inputs.map((input) => input.type),
    headSig.inputs.map((input) => input.type),
  )
  const outputsScore = compareOrderedTypes(baseSig.outputs, headSig.outputs)
  const throwsScore = jaccard(baseSig.throws, headSig.throws)
  return (inputsScore + outputsScore + throwsScore) / 3
}

function compareOrderedTypes(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length !== b.length) return 0
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++
  }
  return matches / a.length
}
