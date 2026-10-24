export interface Ratio {
  readonly numerator: number
  readonly denominator: number
}

interface Weighted {
  readonly weight: number
  readonly value: Ratio
}

type NonEmpty<T> = readonly [T, ...T[]]

export const WHOLE: Ratio = { numerator: 1, denominator: 1 }
export const NONE: Ratio = { numerator: 0, denominator: 1 }

export function quotient(ratio: Ratio): number {
  return ratio.numerator / ratio.denominator
}

// Cross-multiplying keeps the order only while both denominators are positive; a negative one
// inverts the answer instead of producing a visibly wrong number.
export function atLeast(value: Ratio, bound: Ratio): boolean {
  return value.numerator * bound.denominator >= bound.numerator * value.denominator
}

export function mean(values: NonEmpty<Ratio>): Ratio {
  return meanOf(values.map((value) => ({ weight: 1, value })))
}

export function weightedMean(terms: NonEmpty<Weighted>): Ratio {
  return meanOf(terms)
}

function meanOf(terms: readonly Weighted[]): Ratio {
  let numerator = 0
  let denominator = 1
  let totalWeight = 0
  for (const { weight, value } of terms) {
    numerator = numerator * value.denominator + weight * value.numerator * denominator
    denominator *= value.denominator
    totalWeight += weight
  }
  return { numerator, denominator: denominator * totalWeight }
}
