/**
 * The one string order Aburi sorts by: UTF-16 code units, which is what `<` on two strings
 * compares and what ir-schema.md means by "sorted". Every deterministic-output sort in the
 * workspace should route through here so the rule lives in one place.
 */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A comparator over `T` that orders by the string `key` reads from each value. */
export function compareBy<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => compareCodeUnit(key(a), key(b))
}

/** Positional equality of two string arrays. */
export function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
