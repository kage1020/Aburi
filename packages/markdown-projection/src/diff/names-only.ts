import type { Symbol as IRSymbol, SymbolMovedChanged, SymbolUnknown } from "@aburi/types"
import { inlineCode, symbolTitle } from "../format"
import { fileLine } from "./entries"
import type { ChangedEntry } from "./partition"

export function indexSymbols(symbols: readonly IRSymbol[]): string[] {
  return symbols.map((symbol) => indexRow(symbol))
}

export function indexChanged(items: readonly ChangedEntry[]): string[] {
  return items.map((item) => indexRow(item.after))
}

export function indexConfidence(items: readonly ChangedEntry[]): string[] {
  return items.map((item) =>
    indexRow(
      item.after,
      ` (${inlineCode(item.before.confidence)} → ${inlineCode(item.after.confidence)})`,
    ),
  )
}

export function indexUnknown(items: readonly SymbolUnknown[]): string[] {
  return items.map((item) =>
    indexRow(item.symbol, ` (skipped at ${item.absentFrom}: ${item.reason})`),
  )
}

export function indexMovedChanged(items: readonly SymbolMovedChanged[]): string[] {
  return items.map((item) => indexRow(item.after, ` (from ${movedFrom(item.before, item.after)})`))
}

function indexRow(symbol: IRSymbol, suffix = ""): string {
  return `- ${symbolTitle(symbol)} — ${fileLine(symbol)}${suffix}`
}

/** The row already carries the head's `file:line`, so only the base side is named. */
function movedFrom(before: IRSymbol, after: IRSymbol): string {
  if (before.source.file !== after.source.file) return inlineCode(before.source.file)
  return `${inlineCode(before.name)} at L${before.source.startLine}`
}
