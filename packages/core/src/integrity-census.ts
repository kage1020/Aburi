import type { DeclinedCall, IR, Symbol as IRSymbol } from "@aburi/types"
import type { IntegrityViolation } from "./errors"

export function checkSkippedFilesCensus(ir: IR, out: IntegrityViolation[]): void {
  const unparsed = ir.stats.totalFiles - ir.stats.parsedFiles
  if (unparsed < 0) {
    out.push({
      invariant: 21,
      subject: "stats.parsedFiles",
      message: `stats.parsedFiles is ${ir.stats.parsedFiles} of ${ir.stats.totalFiles} total file(s); a scan cannot parse more files than it found`,
    })
  }

  const skippedFiles = ir.stats.skippedFiles
  if (skippedFiles === undefined) return

  if (skippedFiles.length !== unparsed) {
    out.push({
      invariant: 21,
      subject: "stats.skippedFiles",
      message: `stats.skippedFiles names ${skippedFiles.length} file(s) but totalFiles - parsedFiles is ${unparsed}`,
    })
  }

  const seen = new Set<string>()
  for (const file of skippedFiles) {
    if (seen.has(file.path)) {
      out.push({
        invariant: 21,
        subject: "stats.skippedFiles",
        message: `stats.skippedFiles names "${file.path}" more than once; one file is skipped for one reason`,
      })
      continue
    }
    seen.add(file.path)
  }
}

export function checkCallResolutionStatsCensus(ir: IR, out: IntegrityViolation[]): void {
  const stats = ir.stats.callResolution
  if (stats === undefined) return

  let totalCalls = 0
  let resolvedCalls = 0
  for (const symbol of ir.symbols) {
    totalCalls += symbol.calls.length
    for (const call of symbol.calls) if (call.resolved !== null) resolvedCalls++
  }

  if (stats.totalCalls !== totalCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.totalCalls",
      message: `stats.callResolution.totalCalls is ${stats.totalCalls} but symbols[] carry ${totalCalls} call sites`,
    })
  }
  if (stats.resolvedCalls !== resolvedCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.resolvedCalls",
      message: `stats.callResolution.resolvedCalls is ${stats.resolvedCalls} but symbols[] carry ${resolvedCalls} resolved calls`,
    })
  }

  const { unresolved } = stats
  const bucketed =
    unresolved.localScope +
    unresolved.external +
    unresolved.dynamic +
    unresolved.ambiguous +
    unresolved.noMatch
  if (bucketed !== stats.totalCalls - stats.resolvedCalls) {
    out.push({
      invariant: 15,
      subject: "stats.callResolution.unresolved",
      message: `bucket counts sum to ${bucketed} but totalCalls - resolvedCalls is ${stats.totalCalls - stats.resolvedCalls}`,
    })
  }
}

export function checkDeclinedCallsStayCalls(ir: IR, out: IntegrityViolation[]): void {
  const declined = ir.stats.declinedCalls
  if (declined === undefined) return
  const symbols = new Map<string, IRSymbol>(ir.symbols.map((symbol) => [symbol.id, symbol]))
  for (const entry of declined) {
    const message = declinedCallFault(entry, symbols.get(entry.symbolId))
    if (message !== null) out.push({ invariant: 22, subject: "stats.declinedCalls", message })
  }
}

function declinedCallFault(entry: DeclinedCall, owner: IRSymbol | undefined): string | null {
  const where = `${entry.target} (L${entry.line}) [${entry.plugin}]`
  if (owner === undefined)
    return `${where} names "${entry.symbolId}", which is not a Symbol in symbols[]`
  if (owner.dropped) {
    return `${where} names the dropped Symbol "${entry.symbolId}", which carries no calls`
  }
  if (owner.calls.some((call) => call.line === entry.line && call.target === entry.target)) {
    return null
  }
  return `${where} is not among the calls[] of "${entry.symbolId}"; a call no plugin classified stays a call`
}
