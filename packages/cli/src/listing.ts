import type { WarnFn } from "./warn"

/**
 * How many items a warning names individually before the rest are counted.
 *
 * Every list this caps is recorded in full somewhere the reader can still reach: the manifest
 * a dead pattern was declared in, `stats.skippedFiles[]` in the IR, `notCompared[]` in
 * `diff.json`. So the line's job is to show the shape of the loss — one entry, or a flood —
 * rather than to be the record of it, and ten is enough to tell those two apart and still read
 * the detail beside them. Uncapped, such a list runs to the width of the workspace and scrolls
 * every other warning out of the CI log it was meant to appear in. Listings whose entries
 * exist nowhere else (`reportUnrepresentable` in `commands/scan.ts`) deliberately do not use
 * this.
 */
export const MAX_LISTED = 10

/** The first `MAX_LISTED` of `items`, and how many were left out. */
export function capListing<T>(items: readonly T[]): { listed: readonly T[]; hidden: number } {
  return { listed: items.slice(0, MAX_LISTED), hidden: Math.max(0, items.length - MAX_LISTED) }
}

/**
 * A capped listing written *under* the warning that counted it: one indented line per item, then
 * an `…and N more` tail. The indent is what tells a reader the lines belong to the line above
 * rather than standing on their own (`⚠` starts only the latter), so it lives here beside the cap
 * rather than being spelled out at each call site.
 */
export function writeListing(items: readonly string[], write: WarnFn): void {
  const { listed, hidden } = capListing(items)
  for (const item of listed) write(`    ${item}`)
  if (hidden > 0) write(`    …and ${hidden} more`)
}

/** `a, b, c, and N more` — the capped listing as one comma-separated clause. */
export function joinCapped(items: readonly string[]): string {
  const { listed, hidden } = capListing(items)
  return `${listed.join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`
}
