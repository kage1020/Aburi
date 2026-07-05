import type { Symbol as IRSymbol, SymbolDelta } from "@aburi/types"

export type SymbolStatus = "unchanged" | "moved" | "changed" | "moved+changed" | "dropped-toggled"

/**
 * §4 — determine which of the five statuses a matched pair falls into. `dropped-toggled`
 * has absolute priority: whenever `dropped` differs between base and head, every other
 * signal is ignored because the underlying fingerprint change is a consequence of the
 * drop-rule flip, not a genuine code edit (§4.1 rationale).
 *
 * "pathChanged" catches both physical file relocation AND in-file rename: any Symbol id
 * mismatch between base and head means the identifier moved, and DF9 ("method 名 rename
 * (同 file、同 logic) → moved") relies on this. Stage-1 pairs cannot trigger the id branch
 * (they match by exact id), so this only affects stage-2+ pairings where the pair was
 * discovered via fingerprint or name/signature similarity.
 */
export function classifyStatus(base: IRSymbol, head: IRSymbol): SymbolStatus {
  const droppedToggled = base.dropped !== head.dropped
  if (droppedToggled) return "dropped-toggled"
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

/** Direction of a `dropped-toggled` transition (§7.1 SymbolDroppedToggled). */
export type DropDirection = "to-dropped" | "to-kept"

export function dropDirection(head: IRSymbol): DropDirection {
  return head.dropped ? "to-dropped" : "to-kept"
}

/**
 * §4.1 — `dropped-toggled` intentionally elides delta computation. This helper mirrors
 * that by returning a zeroed SymbolDelta: consumers that want to render "nothing changed"
 * can rely on a plain shape rather than optional-chaining every field. Not exported from
 * the package index because the JSON projection never persists it; used by tests only.
 */
export function zeroedDelta(): SymbolDelta {
  return {
    apiChanged: false,
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
  }
}
