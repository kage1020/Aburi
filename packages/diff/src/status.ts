import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"

export type SymbolStatus = "unchanged" | "moved" | "changed" | "moved+changed" | "dropped-toggled"

/**
 * Which of the five statuses a matched pair falls into (diff-algorithm.md). `dropped-toggled`
 * has absolute priority: a fingerprint change under a drop-rule flip is a consequence of the
 * flip, not a code edit.
 *
 * `pathChanged` covers both file relocation and in-file rename: any id mismatch means the
 * identifier moved, which DF9 ("method rename (same file, same logic) → moved") relies on.
 * Stage-1 pairs match by exact id, so only stage-2+ pairings can take the id branch.
 */
export function classifyStatus(base: IRSymbol, head: IRSymbol): SymbolStatus {
  if (base.dropped !== head.dropped) return "dropped-toggled"
  const pathChanged = base.source.file !== head.source.file || base.id !== head.id
  const fingerprintChanged =
    base.fingerprint.api !== head.fingerprint.api ||
    base.fingerprint.logic !== head.fingerprint.logic ||
    base.fingerprint.syntax !== head.fingerprint.syntax
  if (pathChanged && fingerprintChanged) return "moved+changed"
  if (pathChanged) return "moved"
  if (fingerprintChanged) return "changed"
  return "unchanged"
}

/** Direction of a `dropped-toggled` transition (SymbolDroppedToggled, diff-algorithm.md). */
export type DropDirection = "to-dropped" | "to-kept"

export function dropDirection(head: IRSymbol): DropDirection {
  return head.dropped ? "to-dropped" : "to-kept"
}

/**
 * The Symbol a change is reported under: the head side where both exist, otherwise the one
 * side the document holds. Orders `symbols[]` and identifies Slice nodes (slice-view.md).
 */
export function representativeSymbol(change: SymbolChange): IRSymbol {
  return change.status === "added" || change.status === "removed" || change.status === "unknown"
    ? change.symbol
    : change.after
}
