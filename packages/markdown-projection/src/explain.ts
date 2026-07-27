import type { Dependency, Symbol as IRSymbol, UnresolvedCallDiagnostic } from "@aburi/types"
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
   * id. Absent → the section is silently omitted.
   */
  dependencies?: readonly Dependency[]
  /**
   * Per-call resolution diagnostics for THIS Symbol (call-resolution.md §8.1),
   * as produced by the scan that is running right now. Supplying them adds a
   * `## Call resolution` section; omitting them leaves the output byte-identical
   * to what it was before the section existed. The IR cannot carry these — §8.1
   * keeps the reason out of the document — so only a caller holding a live
   * `ScanResult` can pass them.
   */
  unresolvedCalls?: readonly UnresolvedCallDiagnostic[]
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
 * `context.dependencies` is optional so a caller with no reachable call graph
 * can still explain a single Symbol; supplying it enables the `## Called by`
 * section derived from the resolved edges.
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
    // Two-segment emission — local (line-monotonic) first, propagated
    // ((id, target)-monotonic) after — matches effect-propagation.md §8 and the
    // integrity segmentation check. A single-key sort by `line ?? 0` would put
    // every propagated entry before local (they compare as 0), inverting the
    // documented output shape.
    const locals = symbol.effects
      .filter((e) => e.propagated !== true)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    const propagated = symbol.effects
      .filter((e) => e.propagated === true)
      .sort((a, b) =>
        a.id === b.id ? compareStrings(a.target, b.target) : compareStrings(a.id, b.id),
      )
    for (const e of [...locals, ...propagated]) lines.push(effectRow(e))
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

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`
}

/**
 * `aburi explain --debug-resolution` — the per-Symbol view `call-resolution.md`
 * §8.1 promises. One row per call site: the resolved callee, or the bucket that
 * explains the `null`. Rows are ordered by line so they read alongside the
 * source; `Calls` above shows the same sites without the verdict.
 *
 * Passing an empty array is meaningful — it says "the resolver ran and left
 * nothing unresolved here" — so the section renders with an explicit note
 * rather than disappearing. Passing `undefined` (the default) omits it.
 */
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

  lines.push("| line | target | resolved | bucket | candidates |")
  lines.push("|---|---|---|---|---|")
  for (const call of [...symbol.calls].sort((a, b) => a.line - b.line)) {
    const diagnostic = bucketByKey.get(`${call.line}\t${call.target}`)
    const resolved = call.resolved === null ? "—" : `\`${call.resolved}\``
    const bucket = diagnostic === undefined ? "—" : `\`${diagnostic.bucket}\``
    const candidates =
      diagnostic === undefined || diagnostic.candidates.length === 0
        ? "—"
        : diagnostic.candidates.map((c) => `\`${c}\``).join("<br>")
    lines.push(`| ${call.line} | \`${call.target}\` | ${resolved} | ${bucket} | ${candidates} |`)
  }
  lines.push("")
  return lines
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
  return `${lines.join("\n").trimEnd()}\n`
}
