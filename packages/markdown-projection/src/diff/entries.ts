import type {
  Symbol as IRSymbol,
  NotComparedFile,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolUnknown,
} from "@aburi/types"
import { renderSymbolBlock } from "../component"
import { inlineCode, requireDropReason, symbolTitle } from "../format"
import { renderDeltaBody } from "./delta"
import type { ChangedEntry } from "./partition"

export function fileLine(symbol: IRSymbol): string {
  return inlineCode(`${symbol.source.file}:${symbol.source.startLine}`)
}

export function renderChangedList(items: readonly ChangedEntry[]): string[] {
  return items.flatMap((item) => [
    `### ${symbolTitle(item.after)}`,
    `**File**: ${fileLine(item.after)}`,
    "",
    ...renderDeltaBody(item),
    "",
  ])
}

export function renderMovedChanged(items: readonly SymbolMovedChanged[]): string[] {
  return items.flatMap((item) => [
    `### ${symbolTitle(item.after)}`,
    `**Moved**: ${moveRoute(item.before, item.after)} (${inlineCode(item.rationale)})`,
    "**Delta**:",
    ...renderDeltaBody(item),
    "",
  ])
}

export function renderAddedRemoved(symbols: readonly IRSymbol[]): string[] {
  return symbols.flatMap((symbol) => symbolEntry(symbol, []))
}

export function renderUnknown(items: readonly SymbolUnknown[]): string[] {
  return items.flatMap((item) => symbolEntry(item.symbol, [`**Why**: ${unknownExplanation(item)}`]))
}

function symbolEntry(symbol: IRSymbol, extraRows: readonly string[]): string[] {
  return [
    `### ${symbolTitle(symbol)}`,
    `**File**: ${fileLine(symbol)}`,
    ...extraRows,
    ...renderSymbolBlock(symbol).slice(1),
    "",
  ]
}

function unknownExplanation(item: SymbolUnknown): string {
  const side = item.absentFrom
  const fate = side === "head" ? "may still exist" : "may not be new"
  return `the ${side} scan skipped ${skippedFile(item)} (${item.reason}), so this Symbol ${fate}`
}

export function skippedFile(item: SymbolUnknown): string {
  if (item.lostPath === undefined) return inlineCode(item.symbol.source.file)
  return `this file under its ${item.absentFrom} name, ${inlineCode(item.lostPath)}`
}

export function renderNotCompared(files: readonly NotComparedFile[]): string[] {
  if (files.length === 0) return []
  const rows: string[] = []
  for (const file of files) {
    const reasons =
      file.baseReason === file.headReason
        ? `${file.baseReason} on both`
        : `${file.baseReason} at base, ${file.headReason} at head`
    // A renamed file is one entry under two names; the base's is where its base skip record is.
    const name =
      file.basePath === undefined
        ? inlineCode(file.path)
        : `${inlineCode(file.basePath)} → ${inlineCode(file.path)}`
    rows.push(`- ${name} — ${reasons}`)
  }
  rows.push("")
  return rows
}

export function moveRoute(before: IRSymbol, after: IRSymbol): string {
  if (before.source.file !== after.source.file) {
    return `${inlineCode(before.source.file)} → ${inlineCode(after.source.file)}`
  }
  return (
    `within ${inlineCode(after.source.file)}: ${inlineCode(before.name)} (L${before.source.startLine})` +
    ` → ${inlineCode(after.name)} (L${after.source.startLine})`
  )
}

export function renderMoved(items: readonly SymbolMoved[]): string[] {
  return items.map((entry) => {
    const lead =
      entry.before.source.file === entry.after.source.file
        ? ""
        : `${inlineCode(entry.after.name)}: `
    return `- ${lead}${moveRoute(entry.before, entry.after)} (${inlineCode(entry.rationale)})`
  })
}

export function renderDroppedToggled(items: readonly SymbolDroppedToggled[]): string[] {
  const toDropped = items.filter((entry) => entry.direction === "to-dropped")
  const toKept = items.filter((entry) => entry.direction === "to-kept")
  const rows: string[] = []
  if (toDropped.length > 0) {
    rows.push(`**${toDropped.length} to-dropped**`)
    for (const entry of toDropped) {
      rows.push(`- ${inlineCode(entry.after.id)} — ${requireDropReason(entry.after)}`)
    }
  }
  if (toKept.length > 0) {
    if (rows.length > 0) rows.push("")
    rows.push(`**${toKept.length} to-kept**`)
    for (const entry of toKept) rows.push(`- ${inlineCode(entry.after.id)}`)
  }
  return rows
}

export function renderSyntaxOnly(items: readonly ChangedEntry[]): string[] {
  return items.map((entry) => `- ${inlineCode(entry.after.name)} (${fileLine(entry.after)})`)
}
