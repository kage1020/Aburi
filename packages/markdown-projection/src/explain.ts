import type { Dependency, Symbol as IRSymbol, UnresolvedCallDiagnostic } from "@aburi/types"
import {
  callRow,
  compareStrings,
  effectRow,
  inlineCode,
  orderEffects,
  renderDocument,
  requireDropReason,
  ruleRow,
  signatureLine,
  splitDecorators,
  symbolTitle,
  tableHeader,
  tableRow,
} from "./format"

export interface ProjectSymbolExplainContext {
  dependencies?: readonly Dependency[]
  unresolvedCalls?: readonly UnresolvedCallDiagnostic[]
}

export function projectSymbolExplain(
  symbol: IRSymbol,
  context: ProjectSymbolExplainContext = {},
): string {
  if (symbol.dropped) return renderDroppedExplain(symbol)
  return renderKeptExplain(symbol, context)
}

function renderKeptExplain(symbol: IRSymbol, context: ProjectSymbolExplainContext): string {
  const lines: string[] = []
  lines.push(`# ${symbolTitle(symbol)}`)
  lines.push("")
  if (symbol.component !== null && symbol.component !== undefined) {
    lines.push(`**Component**: ${symbol.component}`)
  }
  lines.push(
    `**File**: ${inlineCode(`${symbol.source.file}:${symbol.source.startLine}-${symbol.source.endLine}`)}`,
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
    for (const r of [...symbol.rules].sort((a, b) => a.line - b.line)) lines.push(...ruleRow(r))
    lines.push("")
  }

  if (symbol.effects.length > 0) {
    lines.push("## Effects")
    lines.push("")
    for (const e of orderEffects(symbol.effects)) lines.push(effectRow(e))
    lines.push("")
  }

  if (symbol.calls.length > 0) {
    lines.push("## Calls")
    lines.push("")
    for (const c of [...symbol.calls].sort((a, b) => a.line - b.line)) lines.push(callRow(c))
    lines.push("")
  }

  lines.push(...renderCallResolution(symbol, context.unresolvedCalls))

  const callers = collectCallers(symbol, context.dependencies ?? [])
  if (callers.length > 0) {
    lines.push("## Called by")
    lines.push("")
    for (const from of callers) lines.push(`- ${inlineCode(from)}`)
    lines.push("")
  }

  if (symbol.derivedBy.length > 0) {
    lines.push("## Derived by")
    lines.push("")
    for (const d of [...symbol.derivedBy].sort()) lines.push(`- ${inlineCode(d)}`)
    lines.push("")
  }

  lines.push("## Fingerprint")
  lines.push("")
  lines.push(`- api: ${inlineCode(symbol.fingerprint.api)}`)
  lines.push(`- logic: ${inlineCode(symbol.fingerprint.logic)}`)
  lines.push(`- syntax: ${inlineCode(symbol.fingerprint.syntax)}`)
  lines.push("")

  return renderDocument(lines)
}

function renderCallResolution(
  symbol: IRSymbol,
  diagnostics: readonly UnresolvedCallDiagnostic[] | undefined,
): string[] {
  if (diagnostics === undefined) return []
  const mine = diagnostics.filter((d) => d.symbolId === symbol.id)
  const lines: string[] = ["## Call resolution", ""]
  if (symbol.calls.length === 0) {
    lines.push("_(no call sites)_", "")
    return lines
  }
  const bucketByKey = new Map<string, UnresolvedCallDiagnostic>()
  for (const d of mine) bucketByKey.set(`${d.line}\t${d.target}`, d)

  lines.push(...tableHeader(["line", "target", "resolved", "bucket", "candidates"]))
  for (const call of [...symbol.calls].sort((a, b) => a.line - b.line)) {
    const diagnostic = bucketByKey.get(`${call.line}\t${call.target}`)
    const resolved = call.resolved === null ? "—" : inlineCode(call.resolved)
    const bucket = diagnostic === undefined ? "—" : inlineCode(diagnostic.bucket)
    const candidates =
      diagnostic === undefined || diagnostic.candidates.length === 0
        ? "—"
        : diagnostic.candidates.map((c) => inlineCode(c)).join("<br>")
    lines.push(tableRow([String(call.line), inlineCode(call.target), resolved, bucket, candidates]))
  }
  lines.push("")
  return lines
}

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
  lines.push(`# ${symbolTitle(symbol)} — dropped`)
  lines.push("")
  if (symbol.component !== null && symbol.component !== undefined) {
    lines.push(`**Component**: ${symbol.component}`)
  }
  lines.push(
    `**File**: ${inlineCode(`${symbol.source.file}:${symbol.source.startLine}-${symbol.source.endLine}`)}`,
  )
  lines.push(`**Drop reason**: ${requireDropReason(symbol)}`)
  lines.push("")
  lines.push("_(dropped symbols carry no rules / effects / calls / fingerprint by IR contract.)_")
  lines.push("")
  return renderDocument(lines, { collapseBlankRuns: false })
}
