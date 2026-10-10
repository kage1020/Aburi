import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"

export type SymbolStatus = "unchanged" | "moved" | "changed" | "moved+changed" | "dropped-toggled"

export function classifyStatus(base: IRSymbol, head: IRSymbol): SymbolStatus {
  if (base.dropped !== head.dropped) return "dropped-toggled"
  const pathChanged = base.source.file !== head.source.file || base.id !== head.id
  const contentChanged =
    base.fingerprint.api !== head.fingerprint.api ||
    base.fingerprint.logic !== head.fingerprint.logic ||
    base.fingerprint.syntax !== head.fingerprint.syntax ||
    (!head.dropped && base.confidence !== head.confidence)
  if (pathChanged && contentChanged) return "moved+changed"
  if (pathChanged) return "moved"
  if (contentChanged) return "changed"
  return "unchanged"
}

/** Direction of a `dropped-toggled` transition (SymbolDroppedToggled, diff-algorithm.md). */
export type DropDirection = "to-dropped" | "to-kept"

export function dropDirection(head: IRSymbol): DropDirection {
  return head.dropped ? "to-dropped" : "to-kept"
}

export function representativeSymbol(change: SymbolChange): IRSymbol {
  return change.status === "added" || change.status === "removed" || change.status === "unknown"
    ? change.symbol
    : change.after
}
