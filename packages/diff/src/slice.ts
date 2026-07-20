import { type CallEdge, computeWeaklyConnectedComponents } from "@aburi/core"
import type { SliceRecord, SymbolChange, SymbolId } from "@aburi/types"

/**
 * Slice View clustering pass — docs/design/slice-view.md §2, §4–§8.
 *
 * Groups the changed-Symbol set of a diff into weakly-connected components
 * over the union of base and head call edges. Emits a `SliceRecord[]` whose
 * cluster ids are `"slice:" + <smallest-member Symbol id>`, both `slices[]`
 * and each `members[]` sorted ascending.
 *
 * Pure function: `(changes, baseCallEdges, headCallEdges)` → `SliceRecord[]`.
 * Determinism, idempotence, input-order insensitivity, and locality are all
 * guaranteed — see `computeWeaklyConnectedComponents` in `@aburi/core`.
 */
export interface SliceInput {
  /** SymbolChange records produced by `buildDiff` (pre-sort is not required). */
  changes: readonly SymbolChange[]
  /**
   * Resolved call edges from the base IR. Typically produced by
   * `reconstructCallEdgesFromIR(baseIR)` inside `buildDiff` — Slice View
   * consumes only resolved edges (§5.4), never `Symbol.calls[]` directly.
   */
  baseCallEdges: readonly CallEdge[]
  /** Resolved call edges from the head IR (same source rule as base). */
  headCallEdges: readonly CallEdge[]
}

/**
 * Compute the Slice View for a diff. Returns `[]` when no SymbolChange is
 * Node-eligible per §4.1; callers should still serialise the empty array —
 * the Markdown projection omits the section (§9.4 / §12.5) but the JSON
 * always emits the key so consumers never distinguish "field absent" from
 * "no slices" (§11.2).
 */
export function computeSlices(input: SliceInput): SliceRecord[] {
  const nodeIds = collectNodeIds(input.changes)
  if (nodeIds.length === 0) return []

  const nodeIdSet = new Set<SymbolId>(nodeIds)
  const edges = collectEdges(input.baseCallEdges, input.headCallEdges, nodeIdSet)

  const components = computeWeaklyConnectedComponents<SymbolId>(nodeIds, edges, (id) => id)

  return components.map((members) => ({
    id: `slice:${members[0] as SymbolId}`,
    members: [...members],
  }))
}

/**
 * §4.1 Node selection: keep every SymbolChange whose status is
 * added / removed / changed / moved+changed / dropped-toggled. The identity
 * is the head-side Symbol id where present (added / changed / moved+changed /
 * dropped-toggled), the base-side id for removed. Pure moved and unchanged
 * (already stripped upstream) are excluded — §4.1 / §4.3.
 *
 * The returned array is deliberately not deduplicated: a well-formed
 * SymbolChange list from `buildDiff` never mentions the same Symbol id
 * twice, and Union-Find would coalesce any accidental duplicate anyway.
 */
function collectNodeIds(changes: readonly SymbolChange[]): SymbolId[] {
  const ids: SymbolId[] = []
  for (const change of changes) {
    const id = nodeIdOf(change)
    if (id === null) continue
    ids.push(id)
  }
  return ids
}

function nodeIdOf(change: SymbolChange): SymbolId | null {
  switch (change.status) {
    case "added":
      return change.symbol.id
    case "removed":
      // §4.1 — removed uses base-side id because there is no head symbol.
      return change.symbol.id
    case "changed":
    case "moved+changed":
    case "dropped-toggled":
      return change.after.id
    case "moved":
      // §4.3 — pure moved is not a Node and is not used for bridging either.
      return null
  }
  // Exhaustive: if SymbolChange grows a new status the compile error above
  // fires before this fallback is reachable.
}

/**
 * §5.1 Edge selection: union of base and head, restricted to edges whose
 * BOTH endpoints are Nodes, canonicalised to `(u, v)` with `u < v` (self-
 * loops implicitly dropped). Multi-edges collapse naturally inside the WCC
 * primitive — no explicit dedup needed.
 *
 * The union is the load-bearing rule of §5.3: a controller that called an
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
