import type { CallResolutionStats, UnresolvedCallBuckets } from "@aburi/types"

/**
 * Bucket display order and labels, matching the `call-resolution.md` §8.1 table
 * top to bottom. A fixed order keeps the line diffable between runs; the labels
 * are the kebab-case bucket ids from the doc, not the camelCase JSON keys, so a
 * reviewer reading the line can grep the spec for the same word.
 */
const BUCKET_LABELS: readonly (readonly [keyof UnresolvedCallBuckets, string])[] = [
  ["localScope", "local-scope"],
  ["external", "external"],
  ["dynamic", "dynamic"],
  ["ambiguous", "ambiguous"],
  ["noMatch", "no-match"],
]

/**
 * One-line rendering of `IR.stats.callResolution` for `aburi scan` /
 * `aburi diff` stdout. Answers "did the resolver actually see this call graph,
 * or is the picture below missing edges?" — the question `slice-view.md` §5.4's
 * silent drop otherwise leaves a reviewer unable to ask.
 *
 * Zero-valued buckets are omitted: on a healthy workspace most of the five are
 * zero, and printing them turns a scannable line into noise. When nothing is
 * unresolved the parenthesis disappears altogether.
 */
export function formatCallResolutionLine(stats: CallResolutionStats): string {
  const head = `calls ${stats.totalCalls} · resolved ${stats.resolvedCalls} · unresolved ${
    stats.totalCalls - stats.resolvedCalls
  }`
  const parts: string[] = []
  for (const [key, label] of BUCKET_LABELS) {
    const count = stats.unresolved[key]
    if (count > 0) parts.push(`${label} ${count}`)
  }
  if (parts.length === 0) return head
  return `${head} (${parts.join(" · ")})`
}
