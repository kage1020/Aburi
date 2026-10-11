import type { UndeclaredVocabOccurrence } from "@aburi/core"

export const VOCAB_DISCOVERED_FILENAME = "aburi-vocab-discovered.json"

const SAMPLE_LIMIT = 3

export interface DiscoveredVocabItem {
  kind: UndeclaredVocabOccurrence["kind"]
  value: string
  firstSeenBy: string
  alsoSeenBy: string[]
  occurrences: number
  samples: { file: string; line?: number; symbol: string }[]
}

export function summarizeUndeclaredVocab(
  occurrences: readonly UndeclaredVocabOccurrence[],
): DiscoveredVocabItem[] {
  const items = new Map<string, DiscoveredVocabItem>()
  for (const occurrence of occurrences) {
    const key = `${occurrence.kind} ${occurrence.value}`
    let item = items.get(key)
    if (item === undefined) {
      item = {
        kind: occurrence.kind,
        value: occurrence.value,
        firstSeenBy: occurrence.plugin,
        alsoSeenBy: [],
        occurrences: 0,
        samples: [],
      }
      items.set(key, item)
    } else if (
      occurrence.plugin !== item.firstSeenBy &&
      !item.alsoSeenBy.includes(occurrence.plugin)
    ) {
      item.alsoSeenBy.push(occurrence.plugin)
    }
    item.occurrences++
    if (item.samples.length < SAMPLE_LIMIT) {
      item.samples.push({
        file: occurrence.file,
        ...(occurrence.line === null ? {} : { line: occurrence.line }),
        symbol: occurrence.symbol,
      })
    }
  }
  return [...items.values()]
}

export function renderVocabDiscovered(
  items: readonly DiscoveredVocabItem[],
  discoveredAt: string | null,
): string {
  const document = discoveredAt === null ? { items } : { discoveredAt, items }
  return `${JSON.stringify(document, null, 2)}\n`
}
