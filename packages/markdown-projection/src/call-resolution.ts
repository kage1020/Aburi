import type { CallResolutionStats, UnresolvedCallBuckets } from "@aburi/types"

const BUCKET_LABELS: Readonly<Record<keyof UnresolvedCallBuckets, string>> = {
  localScope: "local-scope",
  external: "external",
  dynamic: "dynamic",
  ambiguous: "ambiguous",
  noMatch: "no-match",
}

export function formatCallResolutionLine(stats: CallResolutionStats): string {
  const head = `calls ${stats.totalCalls} · resolved ${stats.resolvedCalls} · unresolved ${
    stats.totalCalls - stats.resolvedCalls
  }`
  const parts: string[] = []
  for (const key of Object.keys(BUCKET_LABELS) as (keyof UnresolvedCallBuckets)[]) {
    const count = stats.unresolved[key]
    if (count > 0) parts.push(`${BUCKET_LABELS[key]} ${count}`)
  }
  if (parts.length === 0) return head
  return `${head} (${parts.join(" · ")})`
}
