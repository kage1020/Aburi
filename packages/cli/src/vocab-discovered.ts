import type { UndeclaredVocabOccurrence } from "@aburi/core"

/** Written beside the IR by a scan with strict off (`extension-vocab.md`, `config.md`). */
export const VOCAB_DISCOVERED_FILENAME = "aburi-vocab-discovered.json"

/** How many occurrences of one value the record quotes; the rest are counted. */
const SAMPLE_LIMIT = 3

export interface DiscoveredVocabItem {
  kind: UndeclaredVocabOccurrence["kind"]
  value: string
  /** The plugin whose manifest the value belongs in: the first to emit it in this run. */
  firstSeenBy: string
  /** Every other plugin that emitted it, in the order they first did. */
  alsoSeenBy: string[]
  occurrences: number
  samples: { file: string; line?: number; symbol: string }[]
}

/**
 * One item per (kind, value), in the order the scan first met each. Scan order is path order,
 * so the record is the same for the same workspace.
 */
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

/** The file's text. `discoveredAt` is left out when the run suppresses timestamps. */
export function renderVocabDiscovered(
  items: readonly DiscoveredVocabItem[],
  discoveredAt: string | null,
): string {
  const document = discoveredAt === null ? { items } : { discoveredAt, items }
  return `${JSON.stringify(document, null, 2)}\n`
}
