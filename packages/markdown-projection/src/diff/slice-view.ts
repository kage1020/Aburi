import type {
  Symbol as IRSymbol,
  SliceId,
  SliceRecord,
  SymbolChange,
  SymbolDelta,
  SymbolId,
} from "@aburi/types"
import { appendAll, inlineCode } from "../format"
import { fileLine, moveRoute, skippedFile } from "./entries"
import { assertNeverChange } from "./partition"

export function renderSliceView(
  slices: readonly SliceRecord[],
  symbols: readonly SymbolChange[],
): string[] {
  if (slices.length === 0) return []

  const changeById = indexChangesById(symbols)
  const nonSingleton = slices.filter((s) => s.members.length >= 2)
  const singleton = slices.filter((s) => s.members.length < 2)

  const rows: string[] = []
  rows.push(...renderUnresolvedCallNote(slices, changeById))
  for (const slice of nonSingleton) {
    appendAll(rows, renderSliceSection(slice, changeById))
    rows.push("---")
    rows.push("")
  }

  if (singleton.length > 0) {
    rows.push("### Standalone changes")
    rows.push("")
    rows.push("<details>")
    rows.push(
      `<summary>${singleton.length} singleton slices (no in-Node call-graph neighbours)</summary>`,
    )
    rows.push("")
    for (const slice of singleton) {
      const memberId = slice.members[0]
      if (memberId === undefined) {
        throw new Error(
          `projectDiff: slice ${slice.id} has an empty members[]; every Slice has at least one ` +
            "member and members[0] is its anchor.",
        )
      }
      const label = renderSingletonLabel(memberId, slice.id, changeById)
      rows.push(`- ${inlineCode(slice.id)} — ${label}`)
    }
    rows.push("")
    rows.push("</details>")
  }
  return rows
}

function renderSliceSection(
  slice: SliceRecord,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): string[] {
  const rows: string[] = []
  rows.push(`### ${inlineCode(slice.id)} (${slice.members.length} members)`)
  rows.push("")
  for (const memberId of slice.members) {
    const change = requireChangeForMember(memberId, slice.id, changeById)
    const symbol = symbolForMember(change)
    rows.push(`- ${inlineCode(symbol.name)} — *(${change.status})*`)
    rows.push(`  **File**: ${fileLine(symbol)}`)
    rows.push(`  ↳ ${renderMemberFollowup(change)}${unresolvedCallMarker(symbol)}`)
  }
  rows.push("")
  return rows
}

function renderUnresolvedCallNote(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): string[] {
  let affectedMembers = 0
  let unresolvedCalls = 0
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const count = countUnresolvedCalls(symbolForMember(change))
      if (count === 0) continue
      affectedMembers++
      unresolvedCalls += count
    }
  }
  if (unresolvedCalls === 0) return []
  const verb = affectedMembers === 1 ? "makes" : "make"
  const calls = unresolvedCalls === 1 ? "1 call" : `${unresolvedCalls} calls`
  return [
    `> ⚠ ${affectedMembers} of the changed symbols below ${verb} ${calls} the resolver could not identify, so a Slice here may be split rather than genuinely disconnected.`,
    "",
  ]
}

function countUnresolvedCalls(symbol: IRSymbol): number {
  let count = 0
  for (const call of symbol.calls) if (call.resolved === null) count++
  return count
}

function unresolvedCallMarker(symbol: IRSymbol): string {
  const count = countUnresolvedCalls(symbol)
  if (count === 0) return ""
  return ` · ⚠ ${count === 1 ? "1 unresolved call" : `${count} unresolved calls`}`
}

function renderSingletonLabel(
  memberId: SymbolId,
  sliceId: SliceId,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): string {
  const change = requireChangeForMember(memberId, sliceId, changeById)
  const symbol = symbolForMember(change)
  return `${inlineCode(symbol.name)} *(${change.status})*${unresolvedCallMarker(symbol)}`
}

function requireChangeForMember(
  memberId: SymbolId,
  sliceId: SliceId,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): SymbolChange {
  const change = changeById.get(memberId)
  if (change === undefined) {
    throw new Error(
      `projectDiff: slice ${sliceId} lists member ${memberId} that is not present in diff.symbols[]; ` +
        "every Slice member must have a corresponding SymbolChange.",
    )
  }
  return change
}

function symbolForMember(change: SymbolChange): IRSymbol {
  switch (change.status) {
    case "added":
    case "removed":
    case "unknown":
      return change.symbol
    case "changed":
    case "moved+changed":
    case "dropped-toggled":
    case "moved":
      return change.after
    default:
      return assertNeverChange(change)
  }
}

function renderMemberFollowup(change: SymbolChange): string {
  switch (change.status) {
    case "added":
      return "new symbol"
    case "removed":
      return "removed symbol"
    case "moved":
      return `moved: ${moveRoute(change.before, change.after)}`
    case "moved+changed":
      return `moved: ${moveRoute(change.before, change.after)}; ${deltaAxisSummary(change.delta)}`
    case "changed":
      return deltaAxisSummary(change.delta)
    case "dropped-toggled":
      return `dropped-toggled: ${change.direction}`
    case "unknown": {
      const file = change.lostPath === undefined ? "this file" : skippedFile(change)
      return `unknown: the ${change.absentFrom} scan skipped ${file} (${change.reason})`
    }
  }
}

function deltaAxisSummary(delta: SymbolDelta): string {
  const axes: string[] = []
  if (delta.apiChanged) axes.push("delta.apiChanged")
  if (delta.logicChanged) axes.push("delta.logicChanged")
  if (delta.syntaxChanged) axes.push("delta.syntaxChanged")
  if (delta.componentChanged) axes.push("delta.componentChanged")
  if (delta.visibilityChanged) axes.push("delta.visibilityChanged")
  if (delta.confidenceChanged === true) axes.push("delta.confidenceChanged")
  return axes.length === 0 ? "no delta axes" : axes.join(", ")
}

function indexChangesById(symbols: readonly SymbolChange[]): Map<SymbolId, SymbolChange> {
  const map = new Map<SymbolId, SymbolChange>()
  for (const change of symbols) map.set(symbolForMember(change).id, change)
  return map
}
