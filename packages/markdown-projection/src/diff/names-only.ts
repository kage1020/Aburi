import type {
  Symbol as IRSymbol,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolRemoved,
  SymbolUnknown,
} from "@aburi/types"
import { inlineCode, symbolTitle } from "../format"
import { fileLine } from "./entries"
import type { ChangedEntry } from "./partition"

export function indexSymbols(symbols: readonly IRSymbol[]): string[] {
  return symbols.map((symbol) => indexRow(symbol))
}

export function indexRemoved(items: readonly SymbolRemoved[]): string[] {
  return items.map((item) => {
    const into = item.foldedInto ?? null
    return indexRow(item.symbol, into === null ? "" : ` (folded into ${inlineCode(into)})`)
  })
}

export function indexChanged(items: readonly ChangedEntry[]): string[] {
  return items.map((item) => indexRow(item.after, oldName(item)))
}

export function indexConfidence(items: readonly ChangedEntry[]): string[] {
  return items.map((item) =>
    indexRow(
      item.after,
      `${oldName(item)} (${inlineCode(item.before.confidence)} → ${inlineCode(item.after.confidence)})`,
    ),
  )
}

export function indexUnknown(items: readonly SymbolUnknown[]): string[] {
  return items.map((item) =>
    indexRow(item.symbol, ` (skipped at ${item.absentFrom}: ${item.reason})`),
  )
}

export function indexMoved(items: readonly (SymbolMoved | SymbolMovedChanged)[]): string[] {
  return items.map((item) => indexRow(item.after, movedFrom(item)))
}

export function indexDroppedToggled(items: readonly SymbolDroppedToggled[]): string[] {
  return items.map((item) => indexRow(item.after, ` (${item.direction})`))
}

function indexRow(symbol: IRSymbol, suffix = ""): string {
  return `- ${symbolTitle(symbol)} — ${fileLine(symbol)}${suffix}`
}

/** The size cap can omit Moved + Changed and keep this section, so the old name goes here too. */
function oldName(item: ChangedEntry): string {
  return item.before.name === item.after.name ? "" : movedFrom(item)
}

/** The row already carries the head's `file:line`, so only the base side is named. */
function movedFrom({ before, after }: { before: IRSymbol; after: IRSymbol }): string {
  if (before.source.file !== after.source.file) {
    if (before.name === after.name) return ` (from ${inlineCode(before.source.file)})`
    return ` (from ${inlineCode(before.name)} in ${inlineCode(before.source.file)})`
  }
  return ` (from ${inlineCode(before.name)} at L${before.source.startLine})`
}
