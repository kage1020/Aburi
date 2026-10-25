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

/**
 * A resolved call from one changed Symbol to another: the line of its first call, and whether only
 * the base makes it while the caller lives on in the head.
 */
interface CallSite {
  readonly line: number
  readonly removed: boolean
}

type CallSites = ReadonlyMap<SymbolId, ReadonlyMap<SymbolId, CallSite>>

interface Callee {
  readonly id: SymbolId
  readonly removed: boolean
}

const NAMED_STARTS = 3

/** Deeper than this, a list stops reading as a tree; a call chain carries on from a new row. */
const MAX_DEPTH = 5

/** A receiver this short (`e`, `m`, `db`) says nothing about the class it holds. */
const MIN_WORD_LENGTH = 3

export function renderSliceView(
  slices: readonly SliceRecord[],
  symbols: readonly SymbolChange[],
): string[] {
  if (slices.length === 0) return []

  const changeById = indexChangesById(symbols)
  const crossings = unresolvedCrossings(slices, changeById)
  const callSites = resolvedCallSites(symbols)
  const nonSingleton = slices.filter((s) => s.members.length >= 2)
  const singleton = slices.filter((s) => s.members.length < 2)

  const rows: string[] = []
  rows.push(...renderUnresolvedCallNote(crossings))
  for (const slice of nonSingleton) {
    appendAll(rows, renderSliceSection(slice, changeById, callSites, crossings))
  }

  if (singleton.length > 0) {
    rows.push("### Standalone changes")
    rows.push("")
    rows.push("<details>")
    rows.push(
      `<summary>${singleton.length === 1 ? "1 symbol" : `${singleton.length} symbols`} with no resolved call to or from another symbol in this view</summary>`,
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
  callSites: CallSites,
  crossings: ReadonlyMap<SymbolId, readonly Call[]>,
): string[] {
  const symbolOf = new Map<SymbolId, IRSymbol>()
  for (const memberId of slice.members) {
    symbolOf.set(memberId, symbolForMember(requireChangeForMember(memberId, slice.id, changeById)))
  }
  const member = (id: SymbolId): IRSymbol => {
    const symbol = symbolOf.get(id)
    if (symbol === undefined) {
      throw new ProjectionInvariantError(`a member ${id}`, `Slice(id=${slice.id})`)
    }
    return symbol
  }
  const calleesOf = new Map<SymbolId, Callee[]>()
  for (const memberId of slice.members) {
    const sites = [...(callSites.get(memberId) ?? new Map<SymbolId, CallSite>())]
    calleesOf.set(
      memberId,
      sites
        .filter(([callee]) => symbolOf.has(callee) && callee !== memberId)
        // A call that is gone has no line in the head to sit among the others by.
        .sort(
          ([a, x], [b, y]) =>
            Number(x.removed) - Number(y.removed) || x.line - y.line || compareStrings(a, b),
        )
        .map(([id, site]) => ({ id, removed: site.removed })),
    )
  }
  const callees = (id: SymbolId): readonly Callee[] => calleesOf.get(id) ?? []

  const starts = treeStarts(slice.members, (id) => callees(id).map((callee) => callee.id))
  const shown = new Set<SymbolId>()
  const labels = shortFileLabels([...symbolOf.values()].map((symbol) => symbol.source.file))
  const tree: string[] = []
  const resumed: SymbolId[] = []
  const draw = (id: SymbolId, depth: number, removed: boolean) => {
    const indent = "  ".repeat(depth)
    const symbol = member(id)
    const name = inlineCode(symbol.name)
    if (shown.has(id)) {
      tree.push(`${indent}- ${name} *(${removed ? "call removed; " : ""}see above)*`)
      return
    }
    shown.add(id)
    const change = requireChangeForMember(id, slice.id, changeById)
    const at = inlineCode(`${labels.get(symbol.source.file)}:${symbol.source.startLine}`)
    tree.push(
      `${indent}- ${name}${removed ? " *(call removed)*" : ""} — ${renderMemberFollowup(change)} · ${at}${unresolvedCallMarker(crossings.get(id))}`,
    )
    const next = callees(id)
    if (depth === MAX_DEPTH && next.some((callee) => !shown.has(callee.id))) {
      resumed.push(id)
      return
    }
    for (const callee of next) draw(callee.id, depth + 1, callee.removed)
  }
  for (const start of starts) {
    draw(start, 0, false)
    // A resumed chain that is itself too deep is resumed again, further down this list.
    for (const from of resumed) {
      tree.push(`- ${inlineCode(member(from).name)} *(continued)*`)
      for (const callee of callees(from)) draw(callee.id, 1, callee.removed)
    }
    resumed.length = 0
  }
  if (shown.size !== slice.members.length) {
    throw new ProjectionInvariantError("every member reached from a start", `Slice(id=${slice.id})`)
  }

  const files = [...new Set([...symbolOf.values()].map((symbol) => symbol.source.file))].sort(
    compareStrings,
  )
  const startNames = starts.map((id) => inlineCode(member(id).name))
  const named =
    startNames.length <= NAMED_STARTS
      ? startNames.join(", ")
      : `${startNames.slice(0, NAMED_STARTS).join(", ")} and ${startNames.length - NAMED_STARTS} more`
  return [
    `### From ${named} (${slice.members.length} symbols)`,
    "",
    `${files.length === 1 ? "File" : "Files"}: ${files.map(inlineCode).join(", ")}`,
    "",
    ...tree,
    "",
  ]
}

/**
 * Where the trees open: each member no other member calls, and the first member of each ring of
 * calls that no member outside it calls. Every member is reachable from one of them.
 */
function treeStarts(
  members: readonly SymbolId[],
  callees: (id: SymbolId) => readonly SymbolId[],
): SymbolId[] {
  const component = strongComponents(members, callees)
  const entered = new Set<number>()
  for (const id of members) {
    for (const callee of callees(id)) {
      const target = component.get(callee)
      if (target !== undefined && target !== component.get(id)) entered.add(target)
    }
  }
  const opened = new Set<number>()
  return members.filter((id) => {
    const own = component.get(id)
    if (own === undefined || entered.has(own) || opened.has(own)) return false
    opened.add(own)
    return true
  })
}

interface Visit {
  readonly id: SymbolId
  readonly order: number
  low: number
  next: number
}

/**
 * Tarjan's strongly connected components, numbered, without recursion: a chain of calls can be as
 * long as the Slice.
 */
function strongComponents(
  members: readonly SymbolId[],
  callees: (id: SymbolId) => readonly SymbolId[],
): Map<SymbolId, number> {
  const visits = new Map<SymbolId, Visit>()
  const component = new Map<SymbolId, number>()
  let components = 0
  const open: SymbolId[] = []
  const frames: Visit[] = []
  const enter = (id: SymbolId) => {
    const visit = { id, order: visits.size, low: visits.size, next: 0 }
    visits.set(id, visit)
    open.push(id)
    frames.push(visit)
  }
  for (const root of members) {
    if (visits.has(root)) continue
    enter(root)
    for (let visit = frames.at(-1); visit !== undefined; visit = frames.at(-1)) {
      const to = callees(visit.id)[visit.next++]
      if (to !== undefined) {
        const seen = visits.get(to)
        if (seen === undefined) enter(to)
        else if (!component.has(to)) visit.low = Math.min(visit.low, seen.order)
        continue
      }
      frames.pop()
      const parent = frames.at(-1)
      if (parent !== undefined) parent.low = Math.min(parent.low, visit.low)
      if (visit.low !== visit.order) continue
      for (let id = open.pop(); id !== undefined; id = open.pop()) {
        component.set(id, components)
        if (id === visit.id) break
      }
      components++
    }
  }
  return component
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
function resolvedCallSites(symbols: readonly SymbolChange[]): CallSites {
  const headIdOf = new Map<SymbolId, SymbolId>()
  for (const change of symbols) {
    if ("before" in change) headIdOf.set(change.before.id, change.after.id)
  }
  const sites = new Map<SymbolId, Map<SymbolId, CallSite>>()
  for (const change of symbols) {
    const caller = symbolForMember(change).id
    const callees = sites.get(caller) ?? new Map<SymbolId, CallSite>()
    sites.set(caller, callees)
    const revisions = revisionsOf(change)
    const inHead = revisions.some(([, isBase]) => !isBase)
    for (const [symbol, isBase] of revisions) {
      const firstLines = new Map<SymbolId, number>()
      for (const call of symbol.calls) {
        if (call.resolved === null || call.resolved === undefined) continue
        const callee = isBase ? (headIdOf.get(call.resolved) ?? call.resolved) : call.resolved
        const line = firstLines.get(callee)
        if (line === undefined || call.line < line) firstLines.set(callee, call.line)
      }
      for (const [callee, line] of firstLines) {
        if (!callees.has(callee)) callees.set(callee, { line, removed: isBase && inHead })
      }
    }
  }
  return sites
}

/**
 * Head first, so that a call both revisions make keeps the head's line. An unknown Symbol is read
 * as the one revision it has, whose calls are not gone, only unseen in the other.
 */
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

interface NamedMember {
  readonly owner: string | null
  readonly slice: SliceId
}

/**
 * Each member's unresolved calls, in either revision, that could be a call to a member of another
 * Slice. Only such a call could have drawn the edge that joins two Slices; one to `push` or `join`
 * cannot.
 */
function unresolvedCrossings(
  slices: readonly SliceRecord[],
  changeById: ReadonlyMap<SymbolId, SymbolChange>,
): Map<SymbolId, Call[]> {
  const membersByName = new Map<string, NamedMember[]>()
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
      const calls = new Map<string, Call>()
      for (const [revision] of revisionsOf(change)) {
        const callerOwner = nameParts(revision.name).owner
        for (const call of revision.calls) {
          if (call.resolved !== null || calls.has(call.target)) continue
          const target = nameParts(call.target)
          const reaches = (membersByName.get(target.name) ?? []).some(
            (other) => other.slice !== slice.id && couldReach(target, callerOwner, other.owner),
          )
          if (reaches) calls.set(call.target, call)
        }
      }
      if (calls.size > 0) crossings.set(memberId, [...calls.values()])
    }
  }
  return crossings
}

interface NameParts {
  readonly name: string
  /** Everything before the name: the receiver chain of a call, the owner chain of a Symbol. */
  readonly head: string | null
  /** The last segment of `head`. */
  readonly owner: string | null
}

function nameParts(qualified: string): NameParts {
  const name = lastSegment(qualified)
  const head = qualified.slice(0, qualified.length - name.length).replace(/(\.|::)$/, "")
  return head.length === 0
    ? { name, head: null, owner: null }
    : { name, head, owner: lastSegment(head) }
}

/**
 * Whether an unresolved call could be one to a member whose name it ends in. A bare call can reach a
 * plain function and a call through a receiver a method, or names alone would tie every
 * `id.slice(…)` to a helper called `slice`. The resolver already links a call to a method its
 * caller's class declares, so `this.save()` and `super.save()` are left for an inherited one, of a
 * class nothing here names, and `this.repo.save()` for whatever was injected into the field, which
 * its name need not say (`this.db` holding a `Database`). Any other receiver has to share a word
 * with the method's class, as `getRepo` does with `UserRepo` and `part` does not with `rulePayload`.
 */
function couldReach(target: NameParts, callerOwner: string | null, owner: string | null): boolean {
  if (target.head === null || owner === null) return target.head === null && owner === null
  if (target.head === "this" || target.head === "super") return callerOwner !== null
  if (target.head.startsWith("this.") || target.head.startsWith("super.")) return true
  return target.owner !== null && sharesWord(target.owner, owner)
}

function sharesWord(receiver: string, owner: string): boolean {
  const ownerWords = wordsOf(owner)
  return wordsOf(receiver).some((word) =>
    ownerWords.some((other) => word.startsWith(other) || other.startsWith(word)),
  )
}

/** `getHTTPRepo` → `get`, `http`, `repo`; `<computed>` and words shorter than a receiver needs are left out. */
function wordsOf(identifier: string): string[] {
  if (identifier.includes("<")) return []
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH)
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
