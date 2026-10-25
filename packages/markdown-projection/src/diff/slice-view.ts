import type {
  Call,
  Symbol as IRSymbol,
  SliceId,
  SliceRecord,
  SymbolChange,
  SymbolDelta,
  SymbolId,
} from "@aburi/types"
import { appendAll, inlineCode, lastSegment, ProjectionInvariantError } from "../format"
import { fileLine, moveRoute, skippedFile } from "./entries"
import { assertNeverChange } from "./partition"

export function renderSliceView(
  slices: readonly SliceRecord[],
  symbols: readonly SymbolChange[],
): string[] {
  if (slices.length === 0) return []

  const changeById = indexChangesById(symbols)
  const crossings = unresolvedCrossings(slices, changeById)
  const nonSingleton = slices.filter((s) => s.members.length >= 2)
  const singleton = slices.filter((s) => s.members.length < 2)

  const rows: string[] = []
  rows.push(...renderUnresolvedCallNote(crossings))
  for (const slice of nonSingleton) {
    appendAll(rows, renderSliceSection(slice, changeById, crossings))
    rows.push("---")
    rows.push("")
  }

  if (singleton.length > 0) {
    rows.push("### Standalone changes")
    rows.push("")
    rows.push("<details>")
    rows.push(
      `<summary>${singleton.length === 1 ? "1 symbol" : `${singleton.length} symbols`} with no resolved call to or from another changed symbol</summary>`,
    )
    rows.push("")
    for (const slice of singleton) {
      const memberId = slice.members[0]
      if (memberId === undefined) {
        throw new ProjectionInvariantError("members[0]", `Slice(id=${slice.id})`)
      }
      const change = requireChangeForMember(memberId, slice.id, changeById)
      const symbol = symbolForMember(change)
      rows.push(
        `- ${inlineCode(symbol.name)} — *(${change.status})* · ${fileLine(symbol)} · ${renderMemberFollowup(change)}${unresolvedCallMarker(crossings.get(memberId))}`,
      )
    }
    rows.push("")
    rows.push("</details>")
  }
  return rows
}

function renderSliceSection(
  slice: SliceRecord,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
  crossings: ReadonlyMap<SymbolId, readonly Call[]>,
): string[] {
  const rows: string[] = []
  rows.push(`### ${inlineCode(slice.id)} (${slice.members.length} members)`)
  rows.push("")
  for (const memberId of slice.members) {
    const change = requireChangeForMember(memberId, slice.id, changeById)
    const symbol = symbolForMember(change)
    rows.push(`- ${inlineCode(symbol.name)} — *(${change.status})*`)
    rows.push(`  **File**: ${fileLine(symbol)}`)
    rows.push(`  ↳ ${renderMemberFollowup(change)}${unresolvedCallMarker(crossings.get(memberId))}`)
  }
  rows.push("")
  return rows
}

/**
 * Each member's unresolved calls whose target ends in the name of a member of another Slice. Only
 * such a call could have drawn the edge that joins two Slices; one to `push` or `join` cannot.
 */
function unresolvedCrossings(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): Map<SymbolId, Call[]> {
  const slicesByName = new Map<string, Set<SliceId>>()
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const name = lastSegment(symbolForMember(change).name)
      const named = slicesByName.get(name) ?? new Set<SliceId>()
      named.add(slice.id)
      slicesByName.set(name, named)
    }
  }
  const crossings = new Map<SymbolId, Call[]>()
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const calls = symbolForMember(change).calls.filter((call) => {
        if (call.resolved !== null) return false
        const named = slicesByName.get(lastSegment(call.target))
        return named !== undefined && [...named].some((id) => id !== slice.id)
      })
      if (calls.length > 0) crossings.set(memberId, calls)
    }
  }
  return crossings
}

function renderUnresolvedCallNote(crossings: ReadonlyMap<SymbolId, readonly Call[]>): string[] {
  let count = 0
  for (const calls of crossings.values()) count += calls.length
  if (count === 0) return []
  const calls =
    count === 1
      ? "1 call below names a changed symbol in another Slice but was"
      : `${count} calls below name a changed symbol in another Slice but were`
  return [`> ⚠ ${calls} not resolved to it, so those Slices may belong together.`, ""]
}

function unresolvedCallMarker(calls: readonly Call[] | undefined): string {
  if (calls === undefined || calls.length === 0) return ""
  const targets = [...new Set(calls.map((call) => call.target))].map(inlineCode)
  return ` · ⚠ unresolved ${targets.length === 1 ? "call" : "calls"} to ${targets.join(", ")}`
}

function requireChangeForMember(
  memberId: SymbolId,
  sliceId: SliceId,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): SymbolChange {
  const change = changeById.get(memberId)
  if (change === undefined) {
    throw new ProjectionInvariantError(
      `a diff.symbols[] entry for member ${memberId}`,
      `Slice(id=${sliceId})`,
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
      return `new ${surface(change.symbol)}`
    case "removed":
      return `removed ${surface(change.symbol)}`
    case "moved":
      return `moved: ${moveRoute(change.before, change.after)}`
    case "moved+changed":
      return `moved: ${moveRoute(change.before, change.after)}; ${deltaAxisSummary(change.delta)}`
    case "changed":
      return deltaAxisSummary(change.delta)
    case "dropped-toggled":
      return change.direction === "to-dropped" ? "now dropped" : "no longer dropped"
    case "unknown": {
      const file = change.lostPath === undefined ? "this file" : skippedFile(change)
      return `unknown: the ${change.absentFrom} scan skipped ${file} (${change.reason})`
    }
  }
}

/** The kind, and the effects that make an added or removed Symbol worth a look. */
function surface(symbol: IRSymbol): string {
  const effects = [...new Set(symbol.effects.map((effect) => effect.id))]
  return effects.length === 0 ? symbol.kind : `${symbol.kind} with ${effects.join(", ")}`
}

const AXES: ReadonlyArray<readonly [keyof SymbolDelta, string]> = [
  ["apiChanged", "API"],
  ["logicChanged", "logic"],
  ["syntaxChanged", "syntax"],
  ["componentChanged", "component"],
  ["visibilityChanged", "visibility"],
  ["confidenceChanged", "confidence"],
]

function deltaAxisSummary(delta: SymbolDelta): string {
  const axes = AXES.filter(([flag]) => delta[flag] === true).map(([, label]) => label)
  if (axes.length === 0) return "nothing flagged"
  if (axes.length === 1 && axes[0] === "syntax") return "syntax only"
  const leading = axes.slice(0, -1)
  const last = axes[axes.length - 1]
  return `${leading.length === 0 ? last : `${leading.join(", ")} and ${last}`} changed`
}

function indexChangesById(symbols: readonly SymbolChange[]): Map<SymbolId, SymbolChange> {
  const map = new Map<SymbolId, SymbolChange>()
  for (const change of symbols) map.set(symbolForMember(change).id, change)
  return map
}
