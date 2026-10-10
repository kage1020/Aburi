import { type CallEdge, computeWeaklyConnectedComponents, RESERVED_LANGUAGE_IDS } from "@aburi/core"
import type { SliceId, SliceRecord, SymbolChange, SymbolId } from "@aburi/types"
import { DiffError } from "./errors"
import { representativeSymbol } from "./status"

/** The three inputs of the Slice View pass. */
export interface SliceInput {
  /** SymbolChange records produced by `buildDiff` (pre-sort is not required). */
  changes: readonly SymbolChange[]
  baseCallEdges: readonly CallEdge[]
  /** Resolved call edges from the head IR (same source rule as base). */
  headCallEdges: readonly CallEdge[]
}

export function computeSlices(input: SliceInput): SliceRecord[] {
  const nodeIds = collectNodeIds(input.changes)
  if (nodeIds.length === 0) return []

  const nodeIdSet = new Set<SymbolId>(nodeIds)
  const edges = collectEdges(
    input.baseCallEdges,
    input.headCallEdges,
    nodeIdSet,
    nodeIdsByBaseId(input.changes),
  )

  const components = computeWeaklyConnectedComponents<SymbolId>(nodeIds, edges, (id) => id)

  return components.map(makeSliceRecord)
}

const SLICE_ID_PREFIX = "slice:"

function sliceIdFor(anchor: SymbolId): SliceId {
  return `${SLICE_ID_PREFIX}${anchor}` as SliceId
}

function makeSliceRecord(members: readonly SymbolId[]): SliceRecord {
  const anchor = members[0]
  if (anchor === undefined) {
    throw new DiffError(
      "computeSlices: the clustering utility returned an empty component; every weakly-connected " +
        "component contains at least the node that seeded it (slice-view.md).",
      { code: "slice-invariant-violated" },
    )
  }
  const record: SliceRecord = { id: sliceIdFor(anchor), members: [...members] }
  assertSliceRecordInvariant(record)
  return record
}

export function sliceAnchor(record: SliceRecord): SymbolId {
  const anchor = record.members[0]
  if (anchor === undefined) {
    const violation = emptyMembersViolation(record.id)
    throw new DiffError(violation.message, {
      code: "slice-invariant-violated",
      value: violation.subject,
    })
  }
  return anchor
}

export type SliceViolationKind =
  /** Not a `SliceRecord` at all: not an object, or `id` / `members` of the wrong type. */
  | "malformed-shape"
  /** `members[]` has no entries, so the Slice has no anchor. */
  | "members-empty"
  /** `members[]` is not in strictly ascending order, so `members[0]` need not be the smallest. */
  | "members-unordered"
  /** `id` is not `"slice:" + members[0]`. */
  | "id-not-derived"
  /** The anchor is itself in a reserved id namespace, so `id` would read as a doubled prefix. */
  | "anchor-in-reserved-namespace"

export interface SliceRecordViolation {
  kind: SliceViolationKind
  /** The offending record's `id` when it has a usable one, else a short stand-in. */
  subject: string
  /** Human-facing explanation, suitable for an error message or a validator error. */
  message: string
}

export function sliceRecordViolation(value: unknown): SliceRecordViolation | null {
  if (typeof value !== "object" || value === null) {
    return {
      kind: "malformed-shape",
      subject: "<not an object>",
      message: `Expected a SliceRecord object; got ${value === null ? "null" : typeof value}.`,
    }
  }
  const { id, members } = value as { id?: unknown; members?: unknown }
  const subject = typeof id === "string" ? id : "<missing id>"
  if (typeof id !== "string") {
    return {
      kind: "malformed-shape",
      subject,
      message: `SliceRecord ${subject}: id must be a string; got ${typeof id}.`,
    }
  }
  if (!Array.isArray(members) || members.some((member) => typeof member !== "string")) {
    return {
      kind: "malformed-shape",
      subject,
      message: `SliceRecord ${subject}: members must be an array of strings.`,
    }
  }

  const anchor = members[0]
  if (anchor === undefined) return emptyMembersViolation(subject)
  const reservedAnchor = reservedNamespaceOf(anchor)
  if (reservedAnchor !== null) {
    return {
      kind: "anchor-in-reserved-namespace",
      subject,
      message:
        `SliceRecord anchor "${anchor}" uses the reserved language token "${reservedAnchor}", ` +
        `so its Slice id would repeat the prefix (ir-schema.md, slice-view.md).`,
    }
  }
  for (let i = 1; i < members.length; i++) {
    const previous = members[i - 1] as string
    const current = members[i] as string
    if (previous < current) continue
    return {
      kind: "members-unordered",
      subject,
      message:
        `SliceRecord ${subject}: members[] is not in strictly ascending order at index ${i} ` +
        `("${current}" follows "${previous}"), so members[0] is not necessarily the anchor ` +
        `(slice-view.md for the order and uniqueness).`,
    }
  }
  const expected = sliceIdFor(anchor as SymbolId)
  if (id !== expected) {
    return {
      kind: "id-not-derived",
      subject,
      message:
        `SliceRecord id "${id}" is not derived from the anchor "${anchor}"; ` +
        `expected "${expected}" (slice-view.md).`,
    }
  }
  return null
}

/** The reserved token an id opens with, or `null`. Shares the list `@aburi/core` enforces. */
function reservedNamespaceOf(id: string): string | null {
  const colon = id.indexOf(":")
  if (colon < 0) return null
  const token = id.slice(0, colon)
  return RESERVED_LANGUAGE_IDS.has(token) ? token : null
}

/** Single source of the empty-`members[]` wording, shared with `sliceAnchor`. */
function emptyMembersViolation(subject: string): SliceRecordViolation {
  return {
    kind: "members-empty",
    subject,
    message:
      `SliceRecord ${subject}: members[] is empty, so the Slice has no anchor ` +
      `(slice-view.md requires at least one member).`,
  }
}

export function assertSliceRecordInvariant(record: SliceRecord): void {
  const violation = sliceRecordViolation(record)
  if (violation === null) return
  throw new DiffError(violation.message, {
    code: "slice-invariant-violated",
    value: violation.subject,
  })
}

function collectNodeIds(changes: readonly SymbolChange[]): SymbolId[] {
  const ids: SymbolId[] = []
  for (const change of changes) {
    switch (change.status) {
      case "added":
      case "removed":
      case "unknown":
      case "changed":
      case "moved+changed":
      case "dropped-toggled":
        ids.push(representativeSymbol(change).id)
        break
      case "moved":
        break
      default:
        return assertNeverChange(change)
    }
  }
  return ids
}

function assertNeverChange(change: never): never {
  throw new Error(
    `computeSlices: unhandled SymbolChange status ${JSON.stringify(change)}; every status has ` +
      "to declare whether it is a Slice Node (slice-view.md).",
  )
}

function nodeIdsByBaseId(changes: readonly SymbolChange[]): ReadonlyMap<SymbolId, SymbolId> {
  const out = new Map<SymbolId, SymbolId>()
  for (const change of changes) {
    if ("before" in change) out.set(change.before.id, representativeSymbol(change).id)
  }
  return out
}

function collectEdges(
  baseEdges: readonly CallEdge[],
  headEdges: readonly CallEdge[],
  nodeIds: ReadonlySet<SymbolId>,
  nodeIdsByBase: ReadonlyMap<SymbolId, SymbolId>,
): [SymbolId, SymbolId][] {
  const pairs: [SymbolId, SymbolId][] = []
  const asNodeId = (id: SymbolId) => nodeIdsByBase.get(id) ?? id
  for (const edge of baseEdges) {
    appendEdgeIfBothNodes(asNodeId(edge.from), asNodeId(edge.to), nodeIds, pairs)
  }
  for (const edge of headEdges) appendEdgeIfBothNodes(edge.from, edge.to, nodeIds, pairs)
  return pairs
}

function appendEdgeIfBothNodes(
  from: SymbolId,
  to: SymbolId,
  nodeIds: ReadonlySet<SymbolId>,
  out: [SymbolId, SymbolId][],
): void {
  if (!nodeIds.has(from) || !nodeIds.has(to)) return
  out.push([from, to])
}
