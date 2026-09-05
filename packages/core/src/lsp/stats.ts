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

/**
 * The rejection buckets as a `Record`, so a producer can increment the one it is holding
 * (`counts[reason] += 1`) rather than switching over five names. Structurally identical to
 * the generated `LspHintRejections`; `finalizeStats` writes the fields out one by one, which
 * is what keeps the emitted key order fixed.
 */
export type LspHintRejectionCounts = Record<keyof LspHintRejections, number>

/**
 * What the resolver did with the hints it was handed (lsp-enrichment.md §7.2).
 *
 * The producer counters above are the enrichment pass's, but two of the five ways a hint dies
 * are only visible to `resolveCallGraph`, which runs after the pass has returned and does not
 * hold its builder. It reports this instead, and `withHintUsage` folds it in — a value handed
 * back rather than a builder threaded forward, so the resolver stays a pure function of its
 * inputs and cannot be made to depend on whether the LSP pass ran at all.
 *
 * Every field counts *call sites*, not distinct hints: two call sites at one `file:line` key
 * that write the same receiver kind consume the one hint twice.
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

export function emptyHintUsage(): LspHintUsage {
  return { consumed: 0, kindMismatch: 0, targetDropped: 0 }
}

export function finalizeStats(builder: LspStatsBuilder): LspEnrichmentStats {
  return {
    enabled: builder.enabled,
    filesEnriched: builder.filesEnriched,
    filesFellBack: builder.filesFellBack,
    requestsIssued: builder.requestsIssued,
    requestsTimedOut: builder.requestsTimedOut,
    requestsFailed: builder.requestsFailed,
    languagesDisabled: [...builder.languagesDisabled].sort(),
    hintsProduced: builder.hintsProduced,
    // Zero until the resolver reports back. The pass that fills these two runs after this
    // one returns, so a caller that only enriches sees the producer half of §7.2 and an
    // honest "nothing has consumed these yet" for the rest.
    hintsConsumed: 0,
    hintsRejected: { ...builder.hintsRejected },
  }
}

/**
 * Fold the resolver's hint accounting into the stats the enrichment pass produced.
 *
 * Additive rather than assigning, so the two halves of §7.2 cannot silently overwrite one
 * another if a pipeline ever resolves twice against one enrichment.
 */
export function withHintUsage(stats: LspEnrichmentStats, usage: LspHintUsage): LspEnrichmentStats {
  const rejected = stats.hintsRejected
  return {
    ...stats,
    hintsConsumed: (stats.hintsConsumed ?? 0) + usage.consumed,
    hintsRejected: {
      unparseableHover: rejected?.unparseableHover ?? 0,
      ownerClassNotFound: rejected?.ownerClassNotFound ?? 0,
      memberNotFound: rejected?.memberNotFound ?? 0,
      kindMismatch: (rejected?.kindMismatch ?? 0) + usage.kindMismatch,
      targetDropped: (rejected?.targetDropped ?? 0) + usage.targetDropped,
    },
  }
}
