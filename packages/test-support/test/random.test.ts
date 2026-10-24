import { describe, expect, it } from "vitest"
import { seeded } from "../src/random"

function draws(seed: number): number[] {
  const random = seeded(seed)
  return Array.from({ length: 1000 }, () => random())
}

describe("seeded", () => {
  it.each([1, 20261018, 2147483646])("draws the same numbers in (0, 1) from seed %s", (seed) => {
    const numbers = draws(seed)

    expect(draws(seed)).toEqual(numbers)
    expect(numbers.filter((n) => !(n > 0 && n < 1))).toEqual([])
  })

  it.each([0, -1, 2147483647, 4294967294, 1.5, Number.NaN])("refuses seed %s", (seed) => {
    expect(() => seeded(seed)).toThrowError(`seed ${seed} is not an integer from 1 to 2147483646`)
  })
})
