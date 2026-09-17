/**
 * How many items a warning names individually before the rest are counted.
 *
 * A fault broken enough to lose one file usually loses them all, so the untruncated list is
 * the whole workspace — which on CI scrolls every other warning out of the log it was meant to
 * appear in. Ten is enough to see the shape (one path, or many) and read the detail, and the
 * artifact the line points at still holds every entry. Listings whose entries exist nowhere
 * else (`reportUnrepresentable` in `commands/scan.ts`) deliberately do not use this.
 */
export const MAX_LISTED = 10

/** The first `MAX_LISTED` of `items`, and how many were left out. */
export function capListing<T>(items: readonly T[]): { listed: readonly T[]; hidden: number } {
  return { listed: items.slice(0, MAX_LISTED), hidden: Math.max(0, items.length - MAX_LISTED) }
}

/** `a, b, c, and N more` — the capped listing as one comma-separated clause. */
export function joinCapped(items: readonly string[]): string {
  const { listed, hidden } = capListing(items)
  return `${listed.join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`
}
