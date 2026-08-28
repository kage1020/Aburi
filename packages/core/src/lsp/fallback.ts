/**
 * Three-tier fallback state machine (lsp-enrichment.md §6.1):
 *   per-request  → 3 consecutive fails on the same file  → per-file fallback
 *   per-file     → 5 consecutive fails on the same lang  → per-language fallback
 *   per-language → server disabled for the rest of the run + 1 CLI warning
 *
 * All transitions are pure functions of the outcomes recorded so far, so given
 * identical LSP responses the same files/languages fall back on rerun (§10.6).
 */

export interface FallbackState {
  /** Called after a single request completes (success OR failure). */
  onRequest(file: string, ok: boolean): { escalate: boolean }
  /** Called at the end of a file OR when a per-file fallback fires. */
  onFileClose(file: string, language: string, fellBack: boolean): { escalate: boolean }
  /**
   * Called after per-language fallback fires: an `initialize` that failed or threw, a
   * five-file streak, or anything else thrown while enriching that language. The third is the
   * catch-all §6.1 names, and it is the reason this is a plain setter rather than another
   * escalation rule — the caller has already decided.
   */
  onLanguageDisabled(language: string): void
  isLanguageDisabled(language: string): boolean
  isFileFellBack(file: string): boolean
}

export interface FallbackConfig {
  requestsToFile: number
  filesToLanguage: number
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  requestsToFile: 3,
  filesToLanguage: 5,
}

export function createFallbackState(
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG,
): FallbackState {
  const perFileFailStreak = new Map<string, number>()
  const perLanguageFailStreak = new Map<string, number>()
  const fellBackFiles = new Set<string>()
  const disabledLanguages = new Set<string>()

  return {
    onRequest(file, ok) {
      if (ok) {
        perFileFailStreak.set(file, 0)
        return { escalate: false }
      }
      const next = (perFileFailStreak.get(file) ?? 0) + 1
      perFileFailStreak.set(file, next)
      return { escalate: next >= config.requestsToFile }
    },
    onFileClose(file, language, fellBack) {
      if (fellBack) fellBackFiles.add(file)
      perFileFailStreak.set(file, 0)
      if (!fellBack) {
        perLanguageFailStreak.set(language, 0)
        return { escalate: false }
      }
      const next = (perLanguageFailStreak.get(language) ?? 0) + 1
      perLanguageFailStreak.set(language, next)
      return { escalate: next >= config.filesToLanguage }
    },
    onLanguageDisabled(language) {
      disabledLanguages.add(language)
    },
    isLanguageDisabled(language) {
      return disabledLanguages.has(language)
    },
    isFileFellBack(file) {
      return fellBackFiles.has(file)
    },
  }
}
