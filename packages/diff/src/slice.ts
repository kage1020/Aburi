import { type CallEdge, computeWeaklyConnectedComponents, RESERVED_LANGUAGE_IDS } from "@aburi/core"
import type { SliceId, SliceRecord, SymbolChange, SymbolId } from "@aburi/types"
import { DiffError } from "./errors"
import { representativeSymbol } from "./status"

/** The three inputs of the Slice View pass — docs/design/slice-view.md. */
export interface SliceInput {
  /** SymbolChange records produced by `buildDiff` (pre-sort is not required). */
  changes: readonly SymbolChange[]
  /**
   * Resolved call edges from the base IR. Typically produced by
   * `reconstructCallEdgesFromIR(baseIR)` inside `buildDiff` — Slice View
   * consumes only resolved edges, never `Symbol.calls[]` directly.
   */
  baseCallEdges: readonly CallEdge[]
  /** Resolved call edges from the head IR (same source rule as base). */
  headCallEdges: readonly CallEdge[]
}

/**
 * Slice View clustering pass — docs/design/slice-view.md.
 *
 * Groups the changed-Symbol set of a diff into weakly-connected components
 * over the union of base and head call edges. Emits a `SliceRecord[]` whose
 * cluster ids are `"slice:" + <smallest-member Symbol id>`, both `slices[]`
 * and each `members[]` sorted ascending.
 *
 * Pure function: `(changes, baseCallEdges, headCallEdges)` → `SliceRecord[]`.
 * Determinism, idempotence, input-order insensitivity, and locality are all
 * guaranteed — see `computeWeaklyConnectedComponents` in `@aburi/core`.
 *
 * Returns `[]` when no SymbolChange is Node-eligible; callers should
 * still serialise the empty array — the Markdown projection omits the section
 * but the JSON always emits the key so consumers never
 * distinguish "field absent" from "no slices".
 *
 * Every returned record has passed `assertSliceRecordInvariant`.
 */
export function computeSlices(input: SliceInput): SliceRecord[] {
  const nodeIds = collectNodeIds(input.changes)
  if (nodeIds.length === 0) return []

  const nodeIdSet = new Set<SymbolId>(nodeIds)
  const edges = collectEdges(input.baseCallEdges, input.headCallEdges, nodeIdSet)

  const components = computeWeaklyConnectedComponents<SymbolId>(nodeIds, edges, (id) => id)

  return components.map(makeSliceRecord)
}

const SLICE_ID_PREFIX = "slice:"

/**
 * The single place production code derives a Slice id. Everything else
 * in `src/` either receives an id or renders one. (Tests spell the prefix out
 * literally on purpose: an expectation written in terms of the function under
 * test would agree with it no matter what it produced.)
 *
 * The cast is the one place a `SliceId` comes into existence. `SliceId` and
 * `SymbolId` are separate brands precisely so this concatenation cannot be
 * open-coded anywhere else: a bare `"slice:" + x` evaluates to `string`, which
 * `SliceRecord.id` no longer accepts.
 */
function sliceIdFor(anchor: SymbolId): SliceId {
  return `${SLICE_ID_PREFIX}${anchor}` as SliceId
}

/**
 * Build one SliceRecord from an ascending-sorted component and check its own
 * post-condition before letting it out (slice-view.md, enforcement layer 1).
 *
 * The check is not defending against untrusted input — this function builds
 * the id itself, so the derivation clause is true by construction here and
 * only the two clauses about `members` can actually fire. Those are the point:
 * `members[0]` is the anchor only because `computeWeaklyConnectedComponents`
 * returns each component sorted ascending, a guarantee that lives one layer
 * down and is invisible from this file. If it ever stops holding, the diff
 * would otherwise keep emitting well-formed-looking SliceRecords naming the
 * wrong anchor. Here it fails instead.
 */
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

/**
 * The anchor of a Slice: its lexicographically smallest member.
 *
 * Answers from `members[0]`. `id` is derived from the anchor, so
 * reconstructing the anchor by stripping the `"slice:"` prefix is circular at
 * best and, for a record that broke the derivation, silently wrong: it would
 * name a Symbol that is not in the Slice. `id` is read here only to name the
 * offending record in the error message. Consumers that need the anchor call
 * this; consumers that need a label keep using `id` directly.
 */
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

/** Which clause of the slice-view.md derivation invariant a `SliceRecord` broke. */
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

/**
 * Report which clause of the slice-view.md derivation invariant a value breaks, or `null`
 * when it is a well-formed `SliceRecord`. Non-throwing counterpart of
 * `assertSliceRecordInvariant`: the pass wants an exception, a schema
 * validator wants a verdict it can turn into its own error.
 *
 * Takes `unknown` rather than `SliceRecord` deliberately. Enforcement layer 2 points
 * this at documents written by third-party or older producers — data that has
 * not been type-checked by definition — so anything that assumed a well-typed
 * argument would crash on exactly the input it exists to reject.
 */
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
  // A Symbol id in the `slice:` namespace derives to `slice:slice:…`, which is
  // self-consistent — it passes the derivation clause below — but names an id no reader can
  // tell from a Slice id. `makeSymbolId` refuses to build such a Symbol id and
  // `checkIRIntegrity` #16 rejects one read from disk, but `buildDiff` is public API and
  // runs no integrity check, so the doubled prefix is caught here too.
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
  // The one place outside `sliceIdFor` that asserts an id brand, and the reason this
  // function takes `unknown`: the anchor has been checked to be a string and nothing more.
  // Whether it is a well-formed Symbol id is not this check's question — a record whose
  // members are gibberish still has to be told apart from one whose id disagrees with them.
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

/**
 * Throwing form of `sliceRecordViolation`. Raised as a coded `DiffError` so
 * callers branch on `code` rather than parsing the message; which clause broke
 * is `SliceRecordViolation.kind`, for callers that need to tell them apart.
 */
export function assertSliceRecordInvariant(record: SliceRecord): void {
  const violation = sliceRecordViolation(record)
  if (violation === null) return
  throw new DiffError(violation.message, {
    code: "slice-invariant-violated",
    value: violation.subject,
  })
}

/**
 * Node selection: every SymbolChange except pure `moved`, identified by its
 * representative Symbol — the head side where present, the base side for `removed`.
 * `unknown` is a thing a reviewer has to look at, so it belongs in the cluster its
 * neighbours are in. Not deduplicated: `buildDiff` never mentions one id twice, and the
 * WCC primitive coalesces an accidental duplicate anyway.
 *
 * Written as a `switch` over every status rather than as "everything but `moved`", because
 * the second spelling admits a status added to `SymbolChange` later without anyone deciding
 * whether it is a Node. Node membership is what the whole pass is built on — a status
 * silently joining the set would move Slice boundaries and the ids derived from them — so
 * the addition has to fail the build here.
 */
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
        // Not a Node, and not an intermediate connector either (slice-view.md): a pure move
        // leaves the semantic surface unchanged, so clustering it would be noise.
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

/**
 * Edge selection: union of base and head, restricted to edges whose
 * BOTH endpoints are Nodes, canonicalised to `(u, v)` with `u < v` (self-
 * loops implicitly dropped). Multi-edges collapse naturally inside the WCC
 * primitive — no explicit dedup needed.
 *
 * The union is the load-bearing rule of slice-view.md: a controller that called an
 * old service in base and a new service in head needs both edges to land
 * all three Symbols in a single Slice.
 */
function collectEdges(
  baseEdges: readonly CallEdge[],
  headEdges: readonly CallEdge[],
  nodeIds: ReadonlySet<SymbolId>,
): [SymbolId, SymbolId][] {
  const pairs: [SymbolId, SymbolId][] = []
  for (const edge of baseEdges) appendEdgeIfBothNodes(edge, nodeIds, pairs)
  for (const edge of headEdges) appendEdgeIfBothNodes(edge, nodeIds, pairs)
  return pairs
}

function appendEdgeIfBothNodes(
  edge: CallEdge,
  nodeIds: ReadonlySet<SymbolId>,
  out: [SymbolId, SymbolId][],
): void {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return
  out.push([edge.from, edge.to])
}
