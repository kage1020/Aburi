import type { SymbolChange } from "@aburi/types"
import { counted } from "../format"
import {
  indexChanged,
  indexConfidence,
  indexDroppedToggled,
  indexMoved,
  indexRemoved,
  indexSymbols,
  indexUnknown,
} from "./names-only"
import { type ChangedEntry, entrySymbol, partition } from "./partition"

export function inTestFile(change: SymbolChange): boolean {
  return entrySymbol(change).inTestFile === true
}

export function renderTestFiles(changes: readonly SymbolChange[]): string[] {
  const buckets = partition(changes)
  // Moved + Changed lists a moved pair whole, so the delta groups take only what stayed put.
  const stayed = (items: readonly ChangedEntry[]) =>
    items.filter((item) => item.status === "changed")
  const groups: ReadonlyArray<readonly [readonly [string, string], readonly string[]]> = [
    [["API change", "API changes"], indexChanged(stayed(buckets.apiChanged))],
    [["logic change", "logic changes"], indexChanged(stayed(buckets.logicOnly))],
    [["added", "added"], indexSymbols(buckets.added)],
    [["removed", "removed"], indexRemoved(buckets.removed)],
    [["unknown", "unknown"], indexUnknown(buckets.unknown)],
    [["moved + changed", "moved + changed"], indexMoved(buckets.movedChanged)],
    [["moved", "moved"], indexMoved(buckets.moved)],
    [["dropped change", "dropped changes"], indexDroppedToggled(buckets.droppedToggled)],
    [["confidence change", "confidence changes"], indexConfidence(stayed(buckets.confidenceOnly))],
    [["syntax-only change", "syntax-only changes"], indexChanged(stayed(buckets.syntaxOnly))],
  ]
  return groups
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([[one, many], rows], index) => [
      ...(index === 0 ? [] : [""]),
      `**${counted(rows.length, one, many)}**`,
      ...rows,
    ])
}
