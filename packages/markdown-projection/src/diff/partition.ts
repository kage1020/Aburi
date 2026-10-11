import type {
  Symbol as IRSymbol,
  SymbolChange,
  SymbolChanged,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolUnknown,
} from "@aburi/types"
import { compareStrings } from "../format"

export type ChangedEntry = SymbolChanged | SymbolMovedChanged

export interface Buckets {
  apiChanged: ChangedEntry[]
  logicOnly: ChangedEntry[]
  added: IRSymbol[]
  removed: IRSymbol[]
  movedChanged: SymbolMovedChanged[]
  moved: SymbolMoved[]
  droppedToggled: SymbolDroppedToggled[]
  confidenceOnly: ChangedEntry[]
  syntaxOnly: ChangedEntry[]
  unknown: SymbolUnknown[]
}

/** Every bucket comes back in Symbol id order, so a section's names-only rows match its entries. */
export function partition(changes: readonly SymbolChange[]): Buckets {
  const out: Buckets = {
    apiChanged: [],
    logicOnly: [],
    added: [],
    removed: [],
    movedChanged: [],
    moved: [],
    droppedToggled: [],
    confidenceOnly: [],
    syntaxOnly: [],
    unknown: [],
  }
  for (const c of changes) {
    switch (c.status) {
      case "added":
        out.added.push(c.symbol)
        break
      case "removed":
        out.removed.push(c.symbol)
        break
      case "moved":
        out.moved.push(c)
        break
      case "moved+changed":
        out.movedChanged.push(c)
        routeChanged(c, out)
        break
      case "changed":
        routeChanged(c, out)
        break
      case "dropped-toggled":
        out.droppedToggled.push(c)
        break
      case "unknown":
        out.unknown.push(c)
        break
      default:
        return assertNeverChange(c)
    }
  }
  out.apiChanged.sort(byAfterId)
  out.logicOnly.sort(byAfterId)
  out.added.sort(byId)
  out.removed.sort(byId)
  out.movedChanged.sort(byAfterId)
  out.moved.sort(byAfterId)
  out.droppedToggled.sort(byAfterId)
  out.confidenceOnly.sort(byAfterId)
  out.syntaxOnly.sort(byAfterId)
  out.unknown.sort((a, b) => byId(a.symbol, b.symbol))
  return out
}

export function assertNeverChange(change: never): never {
  throw new Error(`Unhandled SymbolChange status: ${JSON.stringify(change)}`)
}

function routeChanged(change: ChangedEntry, out: Buckets): void {
  const { delta } = change
  if (delta.apiChanged) out.apiChanged.push(change)
  else if (delta.logicChanged) out.logicOnly.push(change)
  else if (delta.confidenceChanged === true) out.confidenceOnly.push(change)
  else if (delta.syntaxChanged) out.syntaxOnly.push(change)
}

function byId(a: IRSymbol, b: IRSymbol): number {
  return compareStrings(a.id, b.id)
}

function byAfterId(a: { after: IRSymbol }, b: { after: IRSymbol }): number {
  return byId(a.after, b.after)
}
