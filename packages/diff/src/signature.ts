import type { Signature } from "@aburi/types"

/**
 * §3.4.2 signatureSimilarity — averaged type-similarity across `inputs`, `outputs`, and
 * `throws`. Follows diff-algorithm.md §3.4.2:
 * - null + null    → 1.0 (both symbols are signature-less; nothing to compare)
 * - null + non-null (either side) → 0.0
 * - both non-null: mean of three subscores
 *
 * Subscores:
 * - inputs: ordered type-string equality rate (`i-th type equal` counts as 1, else 0)
 * - outputs: same shape, but outputs is an array of type strings
 * - throws: unordered set intersection over union
 *
 * Empty subarrays on both sides count as 1.0 (they are trivially equal); on one side only
 * they count as 0.0 (asymmetric information).
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
    baseSig.inputs.map((i) => i.type),
    headSig.inputs.map((i) => i.type),
  )
  const outputsScore = compareOrderedTypes(baseSig.outputs, headSig.outputs)
  const throwsScore = compareUnorderedSet(baseSig.throws, headSig.throws)
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

function compareUnorderedSet(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 1 : intersection / union
}
