import type { Dependency, Symbol as IRSymbol } from "@aburi/types"
import {
  callRow,
  compareStrings,
  effectRow,
  requireDropReason,
  ruleRow,
  signatureLine,
  splitDecorators,
} from "./format"

export interface ProjectSymbolExplainContext {
  /**
   * Every Dependency in the current IR. When provided, `projectSymbolExplain`
   * renders a `## Called by` section listing the callers of this Symbol —
   * discovered by scanning `via: "call"` edges whose `to` equals this Symbol's
   * id. Absent → the section is silently omitted (backwards-compatible with
   * the pre-issue-#26 single-argument signature).
   */
  dependencies?: readonly Dependency[]
}

/**
 * §7 — `aburi explain <id>`. A stand-alone Symbol view, richer than the per-Component
 * L2 blocks because it splits every axis into its own section (§7 mock) instead of
 * inlining them under a compact `**Signature**` row. Also carries `derivedBy` and the
 * full fingerprint list (as dedicated `## Fingerprint` block, not the compact `<sub>` line).
 *
 * When the Symbol is `dropped: true`, the design falls back to a short summary —
 * dropped Symbols have no rules/effects/calls/fingerprint by construction (ir-schema §5.6).
 *
 * `context.dependencies` is optional so existing single-argument call sites keep
 * working; passing it in enables the `## Called by` section derived from the
 * resolved call graph.
 */
export function projectSymbolExplain(
  symbol: IRSymbol,
  context: ProjectSymbolExplainContext = {},
): string {
  if (symbol.dropped) return renderDroppedExplain(symbol)
  return renderKeptExplain(symbol, context)
}

function renderKeptExplain(symbol: IRSymbol, context: ProjectSymbolExplainContext): string {
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

  const decoratorParts = splitDecorators(symbol.decorators)
  if (decoratorParts.boundary !== null) {
    lines.push("## Boundary")
    lines.push("")
    lines.push(decoratorParts.boundary)
    lines.push("")
  }
  if (decoratorParts.regular !== null) {
    lines.push("## Decorators")
    lines.push("")
    lines.push(decoratorParts.regular)
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

  const callers = collectCallers(symbol, context.dependencies ?? [])
  if (callers.length > 0) {
    lines.push("## Called by")
    lines.push("")
    for (const from of callers) lines.push(`- \`${from}\``)
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

/**
 * Reverse the `via: "call"` edges to find every Symbol id whose `resolved`
 * points at `symbol`. The list is deduplicated (the same caller can call the
 * same callee on multiple lines, but `Called by` is caller-granular, not
 * per-line) and lex-sorted so the section is byte-stable across runs.
 */
function collectCallers(symbol: IRSymbol, dependencies: readonly Dependency[]): string[] {
  const callers = new Set<string>()
  for (const d of dependencies) {
    if (d.via !== "call") continue
    if (d.to !== symbol.id) continue
    callers.add(d.from)
  }
  return [...callers].sort(compareStrings)
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
  lines.push(`**Drop reason**: ${requireDropReason(symbol)}`)
  lines.push("")
  lines.push("_(dropped symbols carry no rules / effects / calls / fingerprint by IR contract.)_")
  lines.push("")
  return lines.join("\n").trimEnd() + "\n"
}
