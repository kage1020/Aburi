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
  tableHeader,
  tableRow,
} from "./format"

export interface ProjectSymbolExplainContext {
  /**
   * Every Dependency in the current IR. When provided, a `## Called by` section lists the
   * `via: "call"` edges whose `to` is this Symbol. Absent → the section is omitted.
   */
  dependencies?: readonly Dependency[]
  /**
   * Per-call resolution diagnostics for THIS Symbol (call-resolution.md), from the scan
   * running right now — the IR cannot carry them, since the resolver keeps the reason out of
   * the document. Supplying them adds a `## Call resolution` section; omitting them leaves the
   * output as it was before the section existed.
   */
  unresolvedCalls?: readonly UnresolvedCallDiagnostic[]
}

/**
 * markdown-projection.md — `aburi explain <id>`. A stand-alone Symbol view that gives every
 * axis its own section (as in the doc's mock) and carries `derivedBy` and the full
 * fingerprint. A `dropped: true` Symbol falls back to a short summary, since it has no
 * rules/effects/calls/fingerprint (ir-schema.md).
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
  lines.push(`# ${inlineCode(symbol.name)} *(${symbol.kind})*`)
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

/**
 * `aburi explain --debug-resolution` — the per-Symbol view call-resolution.md promises:
 * one row per call site, ordered by line, with the resolved callee or the bucket that
 * explains the `null`. An empty array is meaningful ("the resolver left nothing unresolved
 * here") and renders the section with a note; `undefined` omits it.
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
  // `(line, target)` is not unique — `a(); a()` on one line yields two Call entries — but
  // classification is a pure function of caller, target and site, so colliding entries carry
  // the identical verdict.
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

/** Every Symbol id with a `via: "call"` edge into `symbol`, deduplicated and lex-sorted. */
function collectCallers(symbol: IRSymbol, dependencies: readonly Dependency[]): string[] {
  const callers = new Set<string>()
  for (const d of dependencies) {
    if (d.via !== "call") continue
    if (d.to !== symbol.id) continue
    callers.add(d.from)
  }
  return [...callers].sort(compareStrings)
}

/**
 * The short summary a `dropped: true` Symbol gets instead of the axis sections, and the one
 * renderer here that does not collapse blank runs.
 *
 * Every other document in this package is assembled from sections that each push their own
 * blank line, so the fold is what keeps two adjacent sections from writing two. This one has
 * no sections: its body is a fixed handful of lines, so there is no spacing of its own left
 * for the fold to tidy. What it does have is `dropReason`, which reaches the document
 * verbatim rather than through `inlineCode` — a reason is prose a reviewer reads, not a value
 * in a code span. Folding here would therefore only ever rewrite somebody else's text, and
 * silently reformat the one field this view exists to show. No producer in the tree emits a
 * reason carrying a blank line, so the two behaviours differ on plugin-written IR alone;
 * that is a reason to be deliberate about which one this is, not a reason to have no answer.
 */
function renderDroppedExplain(symbol: IRSymbol): string {
  const lines: string[] = []
  lines.push(`# ${inlineCode(symbol.name)} *(${symbol.kind})* — dropped`)
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
