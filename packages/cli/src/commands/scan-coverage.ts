import { countBy, type SkippedFile } from "@aburi/core"
import type { CoverageFault } from "./scan-report"

type SkipReason = SkippedFile["reason"]

export const SKIP_REASON_RANK: Record<SkipReason, number> = {
  "over-size": 1,
  unreadable: 2,
  unroutable: 3,
  "parse-failed": 4,
  "parse-timeout": 5,
  "extraction-failed": 6,
}

export function findCoverageFault(
  totalFiles: number,
  parsedFiles: number,
  skipped: readonly { reason: SkipReason }[],
  floor: number | undefined,
): CoverageFault | null {
  if (parsedFiles === 0) {
    const dominant = dominantReason(skipped)
    return dominant === null
      ? { kind: "nothing-discovered" }
      : {
          kind: "nothing-parsed",
          totalFiles,
          dominant: dominant.reason,
          dominantCount: dominant.count,
        }
  }
  if (floor === undefined) return null
  if (parsedFiles / totalFiles < floor) {
    return { kind: "below-floor", parsedFiles, totalFiles, floor }
  }
  return null
}

function dominantReason(
  skipped: readonly { reason: SkipReason }[],
): { reason: SkipReason; count: number } | null {
  const counts = countBy(skipped, (file) => file.reason)
  let best: { reason: SkipReason; count: number } | null = null
  for (const [reason, count] of counts) {
    if (best === null || count > best.count) {
      best = { reason, count }
      continue
    }
    if (count === best.count && SKIP_REASON_RANK[reason] < SKIP_REASON_RANK[best.reason]) {
      best = { reason, count }
    }
  }
  return best
}
