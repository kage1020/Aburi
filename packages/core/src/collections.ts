/** Bucket `items` by the key `keyOf` reads from each, preserving insertion order within a bucket. */
export function groupBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  return groups
}

/** Count `items` per key. */
export function countBy<T, K>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>()
  for (const item of items) {
    const key = keyOf(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
