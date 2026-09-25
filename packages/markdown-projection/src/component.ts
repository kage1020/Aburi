import type { Component, Dependency, Symbol as IRSymbol } from "@aburi/types"
import {
  callRow,
  compareEffectIdentity,
  compareStrings,
  decoratorRows,
  droppedFoldout,
  effectRow,
  fingerprintLine,
  inlineCode,
  isSymbolIdEndpoint,
  orderEffects,
  orderFilesAscending,
  orderSymbolsWithinFile,
  propagatedFromSuffix,
  renderDocument,
  requireDropReason,
  ruleRow,
  signatureLine,
  sortDependencies,
  symbolHeading,
} from "./format"

export interface ProjectComponentInput {
  component: Component
  symbols: readonly IRSymbol[]
  dependencies: readonly Dependency[]
}

/**
 * markdown-projection.md — `components/<id>.md` for one Component. `symbols[]` is expected
 * to be the subset that belongs to `component.id`; filtering belongs to the caller, which
 * keeps the projection pure. Newlines are always `\n`; a caller that needs CRLF must
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
    for (const entry of component.publicApi ?? []) lines.push(`- ${inlineCode(entry)}`)
    lines.push("")
  }

  const componentLevelDeps = dependencies.filter(
    (d) =>
      (d.from === component.id || d.to === component.id) &&
      !isSymbolIdEndpoint(d.from) &&
      !isSymbolIdEndpoint(d.to),
  )
  // Keyed by `string`: `isSymbolIdEndpoint` answers about an endpoint's silhouette, not
  // its well-formedness, so the membership test must accept whatever the document holds.
  const symbolIdsInComponent = new Set<string>(keptSymbols.map((s) => s.id))
  const symbolLevelDeps = dependencies.filter(
    (d) =>
      (isSymbolIdEndpoint(d.from) && symbolIdsInComponent.has(d.from)) ||
      (isSymbolIdEndpoint(d.to) && symbolIdsInComponent.has(d.to)),
  )
  if (componentLevelDeps.length > 0 || symbolLevelDeps.length > 0) {
    lines.push("## Dependencies")
    lines.push("")
    for (const d of sortDependencies(componentLevelDeps)) {
      const effectTag = d.effect === null ? "" : ` [${d.effect}]`
      lines.push(`- ${d.from} → ${d.to} (via ${inlineCode(d.via)})${effectTag}`)
    }
    if (symbolLevelDeps.length > 0) {
      if (componentLevelDeps.length > 0) lines.push("")
      lines.push("### Symbol edges")
      for (const d of sortDependencies(symbolLevelDeps)) {
        lines.push(`- ${inlineCode(d.from)} → ${inlineCode(d.to)} (via ${inlineCode(d.via)})`)
      }
    }
    lines.push("")
  }

  lines.push(...renderBoundaryEffectSurface(keptSymbols))

  if (keptSymbols.length > 0) {
    lines.push("## Symbols")
    lines.push("")
    lines.push(...renderSymbolsGroupedByFile(keptSymbols))
  }

  if (droppedSymbols.length > 0) {
    lines.push(
      droppedFoldout(
        [...droppedSymbols]
          .sort((a, b) => compareStrings(a.id, b.id))
          .map((s) => `${inlineCode(s.id)} — ${requireDropReason(s)}`),
      ),
    )
  }
  return renderDocument(lines)
}

function joinCode(items: readonly string[]): string {
  return items.map((item) => inlineCode(item)).join(", ")
}

/**
 * Effects of the Boundary Symbols (a `boundary: true` decorator or a `framework:` extKind).
 * effect-propagation.md puts this rollup in the projection layer: propagation runs to
 * full closure regardless of boundary status; the view chooses what to surface. Every effect
 * (local + propagated) per boundary Symbol, sorted by `(id, target)`; the section is omitted
 * when no boundary Symbol has an effect.
 */
function renderBoundaryEffectSurface(symbols: readonly IRSymbol[]): string[] {
  const boundaries = symbols
    .filter(
      (s) =>
        s.decorators.some((d) => d.boundary === true) ||
        (s.extKind?.startsWith("framework:") ?? false),
    )
    .filter((s) => s.effects.length > 0)
    .sort((a, b) => compareStrings(a.id, b.id))
  if (boundaries.length === 0) return []
  const lines: string[] = ["## Boundary effect surface", ""]
  for (const s of boundaries) {
    const cells = [...s.effects].sort(compareEffectIdentity).map((e) => {
      const base = `${e.id}(${inlineCode(e.target)})`
      if (e.propagated === true) {
        return `${base} ${propagatedFromSuffix(e.derivedFrom ?? [])}`
      }
      return base
    })
    lines.push(`- ${inlineCode(s.name)} — ${cells.join(", ")}`)
  }
  lines.push("")
  return lines
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
    lines.push(`### ${inlineCode(file)}`)
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
 * markdown-projection.md — one Symbol block, with its omit rules: empty `decorators` → no row,
 * `signature: null` → no row, empty `rules` / `effects` / `calls` → no section, dropped
 * fingerprint → no `<sub>` line.
 * A blank line follows each list section that something comes after (§5.2, MP14).
 */
export function renderSymbolBlock(symbol: IRSymbol): string[] {
  const rows: string[] = []
  let afterList = false
  const push = (row: string) => {
    if (afterList) rows.push("")
    afterList = false
    rows.push(row)
  }
  const pushList = (label: string, items: readonly string[]) => {
    push(label)
    rows.push(...items)
    afterList = true
  }
  rows.push(symbolHeading(symbol))
  rows.push(...decoratorRows(symbol.decorators))
  const sig = signatureLine(symbol.signature)
  if (sig !== null) rows.push(`**Signature**: ${sig}`)
  if (symbol.rules.length > 0) {
    pushList(
      "**Rules**:",
      [...symbol.rules].sort((a, b) => a.line - b.line).flatMap((r) => ruleRow(r)),
    )
  }
  if (symbol.effects.length > 0) {
    pushList(
      "**Effects**:",
      orderEffects(symbol.effects).map((e) => effectRow(e)),
    )
  }
  if (symbol.calls.length > 0) {
    pushList(
      "**Calls**:",
      [...symbol.calls].sort((a, b) => a.line - b.line).map((c) => callRow(c)),
    )
  }
  const fp = fingerprintLine(symbol.fingerprint)
  if (fp !== null) push(fp)
  return rows
}
