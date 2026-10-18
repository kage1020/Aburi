export interface Ratio {
  readonly numerator: number
  readonly denominator: number
}

export interface Weighted {
  readonly weight: number
  readonly value: Ratio
}

export const WHOLE: Ratio = { numerator: 1, denominator: 1 }
export const NONE: Ratio = { numerator: 0, denominator: 1 }

export function quotient(ratio: Ratio): number {
  return ratio.numerator / ratio.denominator
}

export function atLeast(a: Ratio, b: Ratio): boolean {
  return a.numerator * b.denominator >= b.numerator * a.denominator
}

export function weightedMean(terms: readonly Weighted[]): Ratio {
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
