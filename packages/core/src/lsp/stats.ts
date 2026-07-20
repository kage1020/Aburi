import type { LanguageId, LspEnrichmentStats } from "@aburi/types"

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
  }
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
  }
}
