import type { Component, Dependency, Symbol as IRSymbol } from "@aburi/types"
import {
  callRow,
  compareStrings,
  decoratorRows,
  droppedFoldout,
  effectRow,
  fingerprintLine,
  isSymbolIdEndpoint,
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

  const componentLevelDeps = dependencies.filter(
    (d) =>
      (d.from === component.id || d.to === component.id) &&
      !isSymbolIdEndpoint(d.from) &&
      !isSymbolIdEndpoint(d.to),
  )
  const symbolIdsInComponent = new Set(symbols.filter((s) => !s.dropped).map((s) => s.id))
  const symbolLevelDeps = dependencies.filter(
    (d) =>
      (isSymbolIdEndpoint(d.from) && symbolIdsInComponent.has(d.from)) ||
      (isSymbolIdEndpoint(d.to) && symbolIdsInComponent.has(d.to)),
  )
  if (componentLevelDeps.length > 0 || symbolLevelDeps.length > 0) {
    lines.push("## Dependencies")
    lines.push("")
    for (const d of sortDeps(componentLevelDeps)) {
      const effectTag = d.effect === null ? "" : ` [${d.effect}]`
      lines.push(`- ${d.from} → ${d.to} (via \`${d.via}\`)${effectTag}`)
    }
    if (symbolLevelDeps.length > 0) {
      if (componentLevelDeps.length > 0) lines.push("")
      lines.push("### Symbol edges")
      for (const d of sortDeps(symbolLevelDeps)) {
        lines.push(`- \`${d.from}\` → \`${d.to}\` (via \`${d.via}\`)`)
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

/**
 * Aggregate effects for Boundary Symbols in the component (framework entry
 * points — decorators with `boundary: true` or `extKind` prefixed `framework:`).
 * effect-propagation.md §4.3 explicitly puts this rollup in the projection
 * layer: propagation runs to full transitive closure regardless of boundary
 * status; the view chooses whether to surface only boundary Symbols.
 *
 * Rows list every effect (local + propagated) attached to each boundary Symbol,
 * sorted by `(id, target)`. Propagated entries include a `[propagated from …]`
 * annotation naming the direct upstream callee. Symbols with no effects are
 * skipped; if no Symbol has both boundary status and at least one effect, the
 * section is omitted entirely.
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
    const cells = [...s.effects]
      .sort((a, b) =>
        a.id === b.id ? compareStrings(a.target, b.target) : compareStrings(a.id, b.id),
      )
      .map((e) => {
        const base = `${e.id}(\`${e.target}\`)`
        if (e.propagated === true) {
          const derivedFrom = (e.derivedFrom ?? []).join(", ")
          return `${base} [propagated from ${derivedFrom}]`
        }
        return base
      })
    lines.push(`- \`${s.name}\` — ${cells.join(", ")}`)
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
    // Locally-detected entries have `line` and sort by it; propagated entries
    // omit `line` (effect-propagation.md §5.1) and are ordered by
    // `(id, target)` after all locals, matching the schema-wide emission order.
    const locals = symbol.effects
      .filter((e) => e.propagated !== true)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    const propagated = symbol.effects
      .filter((e) => e.propagated === true)
      .sort((a, b) =>
        a.id === b.id ? compareStrings(a.target, b.target) : compareStrings(a.id, b.id),
      )
    for (const e of [...locals, ...propagated]) rows.push(effectRow(e))
  }
  if (symbol.calls.length > 0) {
    rows.push("**Calls**:")
    for (const c of [...symbol.calls].sort((a, b) => a.line - b.line)) rows.push(callRow(c))
  }
  const fp = fingerprintLine(symbol.fingerprint)
  if (fp !== null) rows.push(fp)
  return rows
}
