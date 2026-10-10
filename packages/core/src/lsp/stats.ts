import type { LanguageId, LspEnrichmentStats, LspHintRejections } from "@aburi/types"
import { compareCodeUnit } from "../order"

export interface LspStatsBuilder
  extends Omit<LspProducerStats, "languagesDisabled" | "hintsConsumed"> {
  languagesDisabled: Set<LanguageId>
}

/** Every way a hint can be lost, as one name per stats-extension bucket. */
export type LspHintRejectionReason = keyof LspHintRejections

/** The reasons the enrichment pass can record — the producer half of the stats extension. */
export type LspProducerRejection = Extract<
  LspHintRejectionReason,
  "unparseableHover" | "ownerClassNotFound" | "memberNotFound"
>

/** The reasons the resolver can record — the consumer half of the stats extension. */
export type LspConsumerRejection = Extract<LspHintRejectionReason, "kindMismatch" | "targetDropped">

/** The rejection buckets a producer increments in place (`counts[reason] += 1`). */
export type LspHintRejectionCounts = LspHintRejections

export type LspProducerStats = LspEnrichmentStats &
  Required<Pick<LspEnrichmentStats, "hintsProduced" | "hintsConsumed" | "hintsRejected">>

export interface LspHintUsage {
  /** Call sites the LSP tier turned into an edge. */
  consumed: number
  /** Call sites offered a hint written for the other receiver kind. */
  kindMismatch: number
  /** Call sites whose hint named a Symbol a Category B/C rule dropped. */
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
