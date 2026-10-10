import type { WarnFn } from "./warn"

export const MAX_LISTED = 10

/** The first `MAX_LISTED` of `items`, and how many were left out. */
function capListing<T>(items: readonly T[]): { listed: readonly T[]; hidden: number } {
  return { listed: items.slice(0, MAX_LISTED), hidden: Math.max(0, items.length - MAX_LISTED) }
}

export function writeListing(items: readonly string[], write: WarnFn): void {
  const { listed, hidden } = capListing(items)
  for (const item of listed) write(`    ${item}`)
  if (hidden > 0) write(`    …and ${hidden} more`)
}

export function writeFullListing(items: readonly string[], write: WarnFn): void {
  for (const item of items) write(`    ${item}`)
}

/** `a, b, c, and N more` — the capped listing as one comma-separated clause. */
export function joinCapped(items: readonly string[]): string {
  const { listed, hidden } = capListing(items)
  return `${listed.join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`
}
