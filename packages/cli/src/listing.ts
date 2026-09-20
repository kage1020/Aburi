import type { WarnFn } from "./warn"

/**
 * How many items a warning names individually before the rest are counted.
 *
 * Every list this caps is recorded in full somewhere the reader can still reach: the manifest
 * a dead pattern was declared in, `stats.skippedFiles[]` in the IR, `notCompared[]` in
 * `diff.json`. So the line's job is to show the shape of the loss — one entry, or a flood —
 * rather than to be the record of it, and ten is enough to tell those two apart and still read
 * the detail beside them. Uncapped, such a list runs to the width of the workspace and scrolls
 * every other warning out of the CI log it was meant to appear in.
 *
 * Listings whose entries exist nowhere else deliberately do not use this, and write through
 * `writeFullListing` instead: `reportUnrepresentable` and the recoverable-parse-error listing,
 * both in `commands/scan.ts`. Capping the only account of something does not shorten the
 * reader's work, it destroys it.
 */
export const MAX_LISTED = 10

/** The first `MAX_LISTED` of `items`, and how many were left out. */
function capListing<T>(items: readonly T[]): { listed: readonly T[]; hidden: number } {
  return { listed: items.slice(0, MAX_LISTED), hidden: Math.max(0, items.length - MAX_LISTED) }
}

/**
 * One capped listing written *under* the warning that counted it: one indented line per item,
 * then an `…and N more` tail. The tail closes this call's listing, so a caller with several
 * groups to name calls this once per group — two calls in a row read as one list with a count
 * stranded in the middle of it.
 *
 * The indent is what tells a reader the lines belong to the line above rather than standing on
 * their own (`⚠` starts only the latter), so it lives here beside the cap rather than being
 * spelled out at each call site.
 */
export function writeListing(items: readonly string[], write: WarnFn): void {
  const { listed, hidden } = capListing(items)
  for (const item of listed) write(`    ${item}`)
  if (hidden > 0) write(`    …and ${hidden} more`)
}

/**
 * The same listing with no cap, for the callers named on `MAX_LISTED`: where the line is the
 * run's only account of which files these were, a `…and N more` tail is the loss rather than a
 * summary of it. Shares the indent so both kinds of listing sit under their warning alike.
 */
export function writeFullListing(items: readonly string[], write: WarnFn): void {
  for (const item of items) write(`    ${item}`)
}

/** `a, b, c, and N more` — the capped listing as one comma-separated clause. */
export function joinCapped(items: readonly string[]): string {
  const { listed, hidden } = capListing(items)
  return `${listed.join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`
}
