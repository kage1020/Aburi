import type {
  Call,
  Symbol as IRSymbol,
  SliceId,
  SliceRecord,
  SymbolChange,
  SymbolDelta,
  SymbolId,
} from "@aburi/types"
import {
  appendAll,
  compareStrings,
  inlineCode,
  lastSegment,
  ProjectionInvariantError,
} from "../format"
import { fileLine, moveRoute, skippedFile } from "./entries"
import { assertNeverChange } from "./partition"

/** Each caller's resolved callees among the changed Symbols, with the line of the first call. */
type CallLines = ReadonlyMap<SymbolId, ReadonlyMap<SymbolId, number>>

const NAMED_STARTS = 3

/** Deeper than this, a list stops reading as a tree; a call chain carries on from a new row. */
const MAX_DEPTH = 5

export function renderSliceView(
  slices: readonly SliceRecord[],
  symbols: readonly SymbolChange[],
): string[] {
  if (slices.length === 0) return []

  const changeById = indexChangesById(symbols)
  const crossings = unresolvedCrossings(slices, changeById)
  const callLines = resolvedCallLines(symbols)
  const nonSingleton = slices.filter((s) => s.members.length >= 2)
  const singleton = slices.filter((s) => s.members.length < 2)

  const rows: string[] = []
  rows.push(...renderUnresolvedCallNote(crossings))
  for (const slice of nonSingleton) {
    appendAll(rows, renderSliceSection(slice, changeById, callLines, crossings))
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
        `- ${inlineCode(symbol.name)} — ${renderMemberFollowup(change)} · ${fileLine(symbol)}${unresolvedCallMarker(crossings.get(memberId))}`,
      )
    }
    rows.push("")
    rows.push("</details>")
  }
  return rows
}

/**
 * A Slice drawn as the calls that join it, from the members nothing else in it calls, so it reads
 * in the order the code runs rather than in the order of its ids.
 */
function renderSliceSection(
  slice: SliceRecord,
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
  callLines: CallLines,
  crossings: ReadonlyMap<SymbolId, readonly Call[]>,
): string[] {
  const members = new Set(slice.members)
  const symbolOf = new Map<SymbolId, IRSymbol>()
  for (const memberId of slice.members) {
    symbolOf.set(memberId, symbolForMember(requireChangeForMember(memberId, slice.id, changeById)))
  }
  const callees = (caller: SymbolId): SymbolId[] =>
    [...(callLines.get(caller) ?? new Map<SymbolId, number>())]
      .filter(([callee]) => members.has(callee) && callee !== caller)
      .sort(([a, lineA], [b, lineB]) => lineA - lineB || compareStrings(a, b))
      .map(([callee]) => callee)

  const called = new Set(slice.members.flatMap(callees))
  const starts = slice.members.filter((id) => !called.has(id))
  const shown = new Set<SymbolId>()
  const labels = shortFileLabels([...symbolOf.values()].map((symbol) => symbol.source.file))
  const tree: string[] = []
  const resumed: SymbolId[] = []
  const draw = (id: SymbolId, depth: number) => {
    const indent = "  ".repeat(depth)
    const symbol = symbolOf.get(id)
    const change = changeById.get(id)
    if (symbol === undefined || change === undefined) return
    if (shown.has(id)) {
      tree.push(`${indent}- ${inlineCode(symbol.name)} *(see above)*`)
      return
    }
    shown.add(id)
    const at = inlineCode(`${labels.get(symbol.source.file)}:${symbol.source.startLine}`)
    tree.push(
      `${indent}- ${inlineCode(symbol.name)} — ${renderMemberFollowup(change)} · ${at}${unresolvedCallMarker(crossings.get(id))}`,
    )
    const next = callees(id)
    if (depth === MAX_DEPTH && next.length > 0) {
      resumed.push(id)
      return
    }
    for (const callee of next) draw(callee, depth + 1)
  }
  const drawFrom = (id: SymbolId) => {
    draw(id, 0)
    // Rows a resumed chain defers are resumed in turn, as the iterator reads the length each step.
    for (const from of resumed) {
      tree.push(`- ${inlineCode(symbolOf.get(from)?.name ?? from)} *(continued)*`)
      for (const callee of callees(from)) draw(callee, 1)
    }
    resumed.length = 0
  }
  for (const id of starts) drawFrom(id)
  // Members that only call one another in a ring have no start; each ring opens at its first member.
  for (const id of slice.members) {
    if (shown.has(id)) continue
    starts.push(id)
    drawFrom(id)
  }

  const files = [...new Set([...symbolOf.values()].map((symbol) => symbol.source.file))].sort(
    compareStrings,
  )
  return [
    `### From ${startNames(starts, symbolOf)} (${slice.members.length} symbols)`,
    "",
    `${files.length === 1 ? "File" : "Files"}: ${files.map(inlineCode).join(", ")}`,
    "",
    ...tree,
    "",
  ]
}

function startNames(
  starts: readonly SymbolId[],
  symbolOf: ReadonlyMap<SymbolId, IRSymbol>,
): string {
  const names = starts.map((id) => inlineCode(symbolOf.get(id)?.name ?? id))
  if (names.length <= NAMED_STARTS) return names.join(", ")
  return `${names.slice(0, NAMED_STARTS).join(", ")} and ${names.length - NAMED_STARTS} more`
}

/** The fewest trailing path segments that tell each file apart from the others listed with it. */
function shortFileLabels(files: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>()
  let unsettled = [...new Set(files)]
  for (let take = 1; unsettled.length > 0; take++) {
    const byTail = new Map<string, string[]>()
    for (const file of unsettled) {
      const tail = file.split("/").slice(-take).join("/")
      const group = byTail.get(tail)
      if (group === undefined) byTail.set(tail, [file])
      else group.push(file)
    }
    unsettled = []
    for (const [tail, group] of byTail) {
      for (const file of group) {
        if (group.length === 1 || tail === file) labels.set(file, tail)
        else unsettled.push(file)
      }
    }
  }
  return labels
}

/**
 * The calls each changed Symbol makes to another, read from both revisions as the Slices were:
 * a base call is named by the head ids of the pairs at its ends. A head call's line wins over a
 * base one's, since the head is the code under review.
 */
function resolvedCallLines(symbols: readonly SymbolChange[]): CallLines {
  const headIdOf = new Map<SymbolId, SymbolId>()
  for (const change of symbols) {
    if ("before" in change) headIdOf.set(change.before.id, change.after.id)
  }
  const lines = new Map<SymbolId, Map<SymbolId, number>>()
  for (const change of symbols) {
    const caller = symbolForMember(change).id
    const callees = lines.get(caller) ?? new Map<SymbolId, number>()
    lines.set(caller, callees)
    for (const [symbol, isBase] of revisionsOf(change)) {
      for (const call of symbol.calls) {
        if (call.resolved === null || call.resolved === undefined) continue
        const callee = isBase ? (headIdOf.get(call.resolved) ?? call.resolved) : call.resolved
        const known = callees.get(callee)
        if (known === undefined || (!isBase && call.line < known)) callees.set(callee, call.line)
      }
    }
  }
  return lines
}

/** Head first, so that a call both revisions make keeps the head's line. */
function revisionsOf(change: SymbolChange): Array<readonly [IRSymbol, boolean]> {
  switch (change.status) {
    case "added":
      return [[change.symbol, false]]
    case "removed":
      return [[change.symbol, true]]
    case "unknown":
      return [[change.symbol, change.absentFrom === "head"]]
    case "changed":
    case "moved+changed":
    case "dropped-toggled":
    case "moved":
      return [
        [change.after, false],
        [change.before, true],
      ]
    default:
      return assertNeverChange(change)
  }
}

/**
 * Each member's unresolved calls that could be a call to a member of another Slice. Only such a
 * call could have drawn the edge that joins two Slices; one to `push` or `join` cannot.
 */
function unresolvedCrossings(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): Map<SymbolId, Call[]> {
  const membersByName = new Map<string, Array<{ owner: string | null; slice: SliceId }>>()
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const { name, owner } = nameParts(symbolForMember(change).name)
      const named = membersByName.get(name) ?? []
      named.push({ owner, slice: slice.id })
      membersByName.set(name, named)
    }
  }
  const crossings = new Map<SymbolId, Call[]>()
  for (const slice of slices) {
    for (const memberId of slice.members) {
      const change = changeById.get(memberId)
      if (change === undefined) continue
      const caller = symbolForMember(change)
      const callerOwner = nameParts(caller.name).owner
      const calls = caller.calls.filter((call) => {
        if (call.resolved !== null) return false
        const target = nameParts(call.target)
        const receiver = target.owner === "this" ? callerOwner : target.owner
        return (membersByName.get(target.name) ?? []).some(
          (member) =>
            member.slice !== slice.id && ownersAgree(receiver, member.owner, target.owner),
        )
      })
      if (calls.length > 0) crossings.set(memberId, calls)
    }
  }
  return crossings
}

/** The last segment of a qualified name or call target, and the one before it, if any. */
function nameParts(qualified: string): { name: string; owner: string | null } {
  const name = lastSegment(qualified)
  const head = qualified.slice(0, qualified.length - name.length).replace(/(\.|::)$/, "")
  return { name, owner: head.length === 0 ? null : lastSegment(head) }
}

/**
 * Whether a call's receiver could be a member's class or object: `this.repo.save` and
 * `getRepo().save` can reach `Repo.save`, `part.text` cannot reach `rulePayload.text`. Names alone
 * would tie every `id.slice(…)` to a helper called `slice`, so a call through a receiver reaches
 * only a method and a bare call only a plain function.
 */
function ownersAgree(
  receiver: string | null,
  owner: string | null,
  written: string | null,
): boolean {
  if (written === null || owner === null) return written === null && owner === null
  if (receiver === null) return true
  const a = receiver.toLowerCase()
  const b = owner.toLowerCase()
  return a.includes(b) || b.includes(a)
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
