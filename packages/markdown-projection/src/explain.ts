import type { Symbol as IRSymbol } from "@aburi/types"
import { callRow, decoratorRows, effectRow, ruleRow, signatureLine } from "./format"

/**
 * §7 — `aburi explain <id>`. A stand-alone Symbol view, richer than the per-Component
 * L2 blocks because it splits every axis into its own section (§7 mock) instead of
 * inlining them under a compact `**Signature**` row. Also carries `derivedBy` and the
 * full fingerprint list (as dedicated `## Fingerprint` block, not the compact `<sub>` line).
 *
 * When the Symbol is `dropped: true`, the design falls back to a 3-line summary —
 * dropped Symbols have no rules/effects/calls/fingerprint by construction (ir-schema §5.6).
 */
export function projectSymbolExplain(symbol: IRSymbol): string {
  if (symbol.dropped) return renderDroppedExplain(symbol)
  return renderKeptExplain(symbol)
}

function renderKeptExplain(symbol: IRSymbol): string {
  const lines: string[] = []
  lines.push(`# \`${symbol.name}\` *(${symbol.kind})*`)
  lines.push("")
  if (symbol.component !== null && symbol.component !== undefined) {
    lines.push(`**Component**: ${symbol.component}`)
  }
  lines.push(
    `**File**: \`${symbol.source.file}:${symbol.source.startLine}-${symbol.source.endLine}\``,
  )
  lines.push(`**Visibility**: ${symbol.visibility}`)
  lines.push(`**Language**: ${symbol.language}`)
  lines.push("")

  const boundaryRows = decoratorRows(symbol.decorators)
  const boundary = boundaryRows.find((r) => r.startsWith("**Boundary**"))
  const decorators = boundaryRows.find((r) => r.startsWith("**Decorators**"))
  if (boundary !== undefined) {
    lines.push("## Boundary")
    lines.push("")
    lines.push(boundary.replace("**Boundary**: ", ""))
    lines.push("")
  }
  if (decorators !== undefined) {
    lines.push("## Decorators")
    lines.push("")
    lines.push(decorators.replace("**Decorators**: ", ""))
    lines.push("")
  }

  const sig = signatureLine(symbol.signature)
  if (sig !== null) {
    lines.push("## Signature")
    lines.push("")
    lines.push(sig)
    lines.push("")
  }

  if (symbol.rules.length > 0) {
    lines.push("## Rules")
    lines.push("")
    for (const r of [...symbol.rules].sort((a, b) => a.line - b.line)) lines.push(ruleRow(r))
    lines.push("")
  }

  if (symbol.effects.length > 0) {
    lines.push("## Effects")
    lines.push("")
    for (const e of [...symbol.effects].sort((a, b) => a.line - b.line)) lines.push(effectRow(e))
    lines.push("")
  }

  if (symbol.calls.length > 0) {
    lines.push("## Calls")
    lines.push("")
    for (const c of [...symbol.calls].sort((a, b) => a.line - b.line)) lines.push(callRow(c))
    lines.push("")
  }

  if (symbol.derivedBy.length > 0) {
    lines.push("## Derived by")
    lines.push("")
    for (const d of [...symbol.derivedBy].sort()) lines.push(`- \`${d}\``)
    lines.push("")
  }

  lines.push("## Fingerprint")
  lines.push("")
  lines.push(`- api: \`${symbol.fingerprint.api}\``)
  lines.push(`- logic: \`${symbol.fingerprint.logic}\``)
  lines.push(`- syntax: \`${symbol.fingerprint.syntax}\``)
  lines.push("")

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  )
}

function renderDroppedExplain(symbol: IRSymbol): string {
  const lines: string[] = []
  lines.push(`# \`${symbol.name}\` *(${symbol.kind})* — dropped`)
  lines.push("")
  if (symbol.component !== null && symbol.component !== undefined) {
    lines.push(`**Component**: ${symbol.component}`)
  }
  lines.push(
    `**File**: \`${symbol.source.file}:${symbol.source.startLine}-${symbol.source.endLine}\``,
  )
  lines.push(`**Drop reason**: ${symbol.dropReason ?? "unspecified"}`)
  lines.push("")
  lines.push("_(dropped symbols carry no rules / effects / calls / fingerprint by IR contract.)_")
  lines.push("")
  return lines.join("\n").trimEnd() + "\n"
}
