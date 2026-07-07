import type { Component, Dependency, Symbol as IRSymbol } from "@aburi/types"
import {
  callRow,
  compareStrings,
  decoratorRows,
  droppedFoldout,
  effectRow,
  fingerprintLine,
  orderFilesAscending,
  orderSymbolsWithinFile,
  requireDropReason,
  ruleRow,
  signatureLine,
  symbolHeading,
} from "./format"

export interface ProjectComponentInput {
  component: Component
  symbols: readonly IRSymbol[]
  dependencies: readonly Dependency[]
}

/**
 * §5 — Emit `components/<id>.md` for one Component. `symbols[]` is expected to be the
 * subset that belongs to `component.id`; the projection layer does not filter — that
 * belongs to whoever calls it (the CLI or, in tests, the caller directly). This keeps
 * the projection layer pure and cheap to test.
 *
 * The output is line-terminator-neutral: newlines are always `\n` because §3.2 fixes
 * the ordering and §3.1 pins the dialect to CommonMark. A caller that needs CRLF must
 * post-process.
 */
export function projectComponent(input: ProjectComponentInput): string {
  const { component, symbols, dependencies } = input
  const keptSymbols = symbols.filter((s) => !s.dropped)
  const droppedSymbols = symbols.filter((s) => s.dropped)

  const lines: string[] = []
  lines.push(`# Component: ${component.id}`)
  lines.push("")
  lines.push(`**Name**: ${component.name}`)
  lines.push(`**Roots**: ${joinCode(component.roots)}`)
  lines.push(`**Languages**: ${component.languages.join(", ")}`)
  if ((component.frameworks ?? []).length > 0) {
    lines.push(`**Frameworks**: ${(component.frameworks ?? []).join(", ")}`)
  }
  lines.push(`**Symbols**: ${keptSymbols.length} kept · ${droppedSymbols.length} dropped`)
  lines.push("")

  if ((component.publicApi ?? []).length > 0) {
    lines.push("## Public API")
    lines.push("")
    for (const entry of component.publicApi ?? []) lines.push(`- \`${entry}\``)
    lines.push("")
  }

  const componentDeps = dependencies.filter((d) => d.from === component.id || d.to === component.id)
  if (componentDeps.length > 0) {
    lines.push("## Dependencies")
    lines.push("")
    for (const d of sortDeps(componentDeps)) {
      const effectTag = d.effect === null ? "" : ` [${d.effect}]`
      lines.push(`- ${d.from} → ${d.to} (via \`${d.via}\`)${effectTag}`)
    }
    lines.push("")
  }

  if (keptSymbols.length > 0) {
    lines.push("## Symbols")
    lines.push("")
    lines.push(...renderSymbolsGroupedByFile(keptSymbols))
  }

  if (droppedSymbols.length > 0) {
    lines.push(
      droppedFoldout(
        droppedSymbols
          .slice()
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((s) => `\`${s.id}\` — ${requireDropReason(s)}`),
      ),
    )
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  )
}

function joinCode(items: readonly string[]): string {
  return items.map((i) => `\`${i}\``).join(", ")
}

function sortDeps(deps: readonly Dependency[]): Dependency[] {
  return [...deps].sort((a, b) => {
    if (a.from !== b.from) return compareStrings(a.from, b.from)
    if (a.to !== b.to) return compareStrings(a.to, b.to)
    return compareStrings(a.via, b.via)
  })
}

function renderSymbolsGroupedByFile(symbols: readonly IRSymbol[]): string[] {
  const byFile = new Map<string, IRSymbol[]>()
  for (const s of symbols) {
    const bucket = byFile.get(s.source.file) ?? []
    bucket.push(s)
    byFile.set(s.source.file, bucket)
  }
  const lines: string[] = []
  for (const file of orderFilesAscending([...byFile.keys()])) {
    lines.push(`### \`${file}\``)
    lines.push("")
    const inFile = orderSymbolsWithinFile(byFile.get(file) ?? [])
    for (const s of inFile) {
      lines.push(...renderSymbolBlock(s))
      lines.push("")
    }
  }
  return lines
}

/**
 * §5.2 — one Symbol block. Section-omit rules from §5.3 are applied here: `decorators`
 * empty → no row, `signature: null` → no row, empty `rules` / `effects` / `calls` → no
 * section, dropped fingerprint → no `<sub>` line.
 */
export function renderSymbolBlock(symbol: IRSymbol): string[] {
  const rows: string[] = []
  rows.push(symbolHeading(symbol))
  rows.push(...decoratorRows(symbol.decorators))
  const sig = signatureLine(symbol.signature)
  if (sig !== null) rows.push(`**Signature**: ${sig}`)
  if (symbol.rules.length > 0) {
    rows.push("**Rules**:")
    for (const r of [...symbol.rules].sort((a, b) => a.line - b.line)) rows.push(ruleRow(r))
  }
  if (symbol.effects.length > 0) {
    rows.push("**Effects**:")
    for (const e of [...symbol.effects].sort((a, b) => a.line - b.line)) rows.push(effectRow(e))
  }
  if (symbol.calls.length > 0) {
    rows.push("**Calls**:")
    for (const c of [...symbol.calls].sort((a, b) => a.line - b.line)) rows.push(callRow(c))
  }
  const fp = fingerprintLine(symbol.fingerprint)
  if (fp !== null) rows.push(fp)
  return rows
}
