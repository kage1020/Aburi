import type { LanguageId, LspEnrichmentStats, LspHintRejections } from "@aburi/types"

/**
 * Mutable accumulator for `stats.lspEnrichment` (lsp-enrichment.md §7.2).
 * Frozen at the end of the pass with `finalize()`.
 */
export interface LspStatsBuilder {
  enabled: boolean
  filesEnriched: number
  filesFellBack: number
  requestsIssued: number
  requestsTimedOut: number
  requestsFailed: number
  languagesDisabled: Set<LanguageId>
  hintsProduced: number
  hintsRejected: LspHintRejectionCounts
}

/** Every way a hint can be lost, as one name per §7.2 bucket. */
export type LspHintRejectionReason = keyof LspHintRejections

/** The reasons the enrichment pass can record — the producer half of §7.2. */
export type LspProducerRejection = Extract<
  LspHintRejectionReason,
  "unparseableHover" | "ownerClassNotFound" | "memberNotFound"
>

/** The reasons the resolver can record — the consumer half of §7.2. */
export type LspConsumerRejection = Extract<LspHintRejectionReason, "kindMismatch" | "targetDropped">

/**
 * The rejection buckets as a `Record`, so a producer can increment the one it is holding
 * (`counts[reason] += 1`) rather than switching over five names. Structurally identical to
 * the generated `LspHintRejections`, which is the shape that reaches the IR.
 */
export type LspHintRejectionCounts = Record<LspHintRejectionReason, number>

/**
 * What the enrichment pass alone can say about hints (lsp-enrichment.md §7.2).
 *
 * Its three fields are required where the IR type has them optional, which is the difference
 * between "this pass ran and wrote them" and "this document may predate them" — the IR type
 * cannot make them required, because v1 is frozen against exactly that (ir-schema.md §15.2).
 * Stating it here instead is what lets `withHintUsage` read them without a `?? 0` that would
 * quietly turn a Class B absence into a counted zero.
 *
 * The two `Lsp*Rejection` halves above are why this type exists at all rather than
 * `LspEnrichmentStats` being returned straight from `finalizeStats`: the record is written by
 * two passes, and only the second of them can finish it.
 */
export type LspProducerStats = LspEnrichmentStats &
  Required<Pick<LspEnrichmentStats, "hintsProduced" | "hintsConsumed" | "hintsRejected">>

/**
 * What the resolver did with the hints it was handed (lsp-enrichment.md §7.2).
 *
 * Two of the five ways a hint dies are visible only to `resolveCallGraph`, which runs after
 * the enrichment pass has returned and holds none of its state. It reports this instead of
 * being handed the builder: a value passed back keeps the resolver a pure function of its
 * inputs, and keeps a counter about hints from depending on a pass that may never have run.
 * `withHintUsage` folds the two halves together; `scan()` is where that happens.
 *
 * Every field counts *call sites*, not distinct hints: two identical call sites share a key,
 * so the one hint standing there is consumed twice.
 */
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

/**
 * Record one enrichment-side rejection.
 *
 * Typed on `LspProducerRejection` rather than the full reason union so the pass cannot reach
 * `kindMismatch` or `targetDropped`: those describe a decision only the resolver makes, and a
 * pass that wrote one would make the two sums in §7.2 stop meaning what they say.
 */
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
  return {
    enabled: builder.enabled,
    filesEnriched: builder.filesEnriched,
    filesFellBack: builder.filesFellBack,
    requestsIssued: builder.requestsIssued,
    requestsTimedOut: builder.requestsTimedOut,
    requestsFailed: builder.requestsFailed,
    languagesDisabled: [...builder.languagesDisabled].sort(),
    hintsProduced: builder.hintsProduced,
    // Zero until the resolver reports back. The pass that fills these two runs after this one
    // returns, so a caller that only enriches sees the producer half of §7.2 and an honest
    // "nothing has consumed these yet" for the rest — which is what `LspProducerStats` names.
    hintsConsumed: 0,
    hintsRejected: { ...builder.hintsRejected },
  }
}

/**
 * Fold the resolver's hint accounting into the stats the enrichment pass produced, completing
 * the §7.2 record.
 *
 * Additive rather than assigning, so the two halves cannot silently overwrite one another if a
 * pipeline ever resolves twice against one enrichment.
 */
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
