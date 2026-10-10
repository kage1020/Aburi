import type { LanguageId, LspEnrichmentStats, LspHintRejections } from "@aburi/types"
import { compareCodeUnit } from "../order"

export interface LspStatsBuilder
  extends Omit<LspProducerStats, "languagesDisabled" | "hintsConsumed"> {
  languagesDisabled: Set<LanguageId>
}

export type LspHintRejectionReason = keyof LspHintRejections

export type LspProducerRejection = Extract<
  LspHintRejectionReason,
  "unparseableHover" | "ownerClassNotFound" | "memberNotFound"
>

export type LspConsumerRejection = Extract<LspHintRejectionReason, "kindMismatch" | "targetDropped">

export type LspHintRejectionCounts = LspHintRejections

export type LspProducerStats = LspEnrichmentStats &
  Required<Pick<LspEnrichmentStats, "hintsProduced" | "hintsConsumed" | "hintsRejected">>

/** Counts call sites, not hints: two identical calls on one line share a hint and consume it twice. */
export interface LspHintUsage {
  consumed: number
  kindMismatch: number
  targetDropped: number
}

export function createStatsBuilder(enabled: boolean): LspStatsBuilder {
  return {
    enabled,
    filesEnriched: 0,
    filesFellBack: 0,
    requestsIssued: 0,
    requestsTimedOut: 0,
    requestsFailed: 0,
    languagesDisabled: new Set(),
    hintsProduced: 0,
    hintsRejected: {
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 0,
      kindMismatch: 0,
      targetDropped: 0,
    },
  }
}

export function countProducerRejection(
  builder: LspStatsBuilder,
  reason: LspProducerRejection,
): void {
  builder.hintsRejected[reason] += 1
}

export function emptyHintUsage(): LspHintUsage {
  return { consumed: 0, kindMismatch: 0, targetDropped: 0 }
}

export function finalizeStats(builder: LspStatsBuilder): LspProducerStats {
  const { languagesDisabled, hintsRejected, ...counters } = builder
  return {
    ...counters,
    languagesDisabled: [...languagesDisabled].sort(compareCodeUnit),
    hintsConsumed: 0,
    hintsRejected: { ...hintsRejected },
  }
}

export function withHintUsage(stats: LspProducerStats, usage: LspHintUsage): LspEnrichmentStats {
  const rejected = stats.hintsRejected
  return {
    ...stats,
    hintsConsumed: stats.hintsConsumed + usage.consumed,
    hintsRejected: {
      ...rejected,
      kindMismatch: rejected.kindMismatch + usage.kindMismatch,
      targetDropped: rejected.targetDropped + usage.targetDropped,
    },
  }
}
