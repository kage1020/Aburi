export interface FallbackState {
  onRequest(file: string, ok: boolean): { escalate: boolean }
  onFileClose(file: string, language: string, fellBack: boolean): { escalate: boolean }
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
      perFileFailStreak.set(file, 0)
      if (!fellBack) {
        perLanguageFailStreak.set(language, 0)
        return { escalate: false }
      }
      const next = (perLanguageFailStreak.get(language) ?? 0) + 1
      perLanguageFailStreak.set(language, next)
      return { escalate: next >= config.filesToLanguage }
    },
  }
}
