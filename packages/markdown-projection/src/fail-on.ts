import type { Summary } from "@aburi/types"

/**
 * The status buckets `--fail-on` can gate against. Mirrors `SymbolChange["status"]` on
 * the diff side plus the two nested `dropped-toggled` directions the design calls out
 * (`dropped-toggled:to-dropped` and `dropped-toggled:to-kept`).
 */
export type FailOnStatus =
  | "added"
  | "removed"
  | "changed"
  | "moved"
  | "moved+changed"
  | "dropped-toggled"
  | "dropped-toggled:to-dropped"
  | "dropped-toggled:to-kept"

/** Comparison operator when a numeric threshold is attached (`>N` per WI-13 AC 5). */
export type FailOnComparator = ">" | ">=" | "==" | "<="

/**
 * A `--fail-on` clause. `count` and `comparator` are absent when the gate is a bare
 * status (`--fail-on changed`), present when the gate carries a threshold
 * (`--fail-on changed:>10`).
 */
export interface FailOnClause {
  status: FailOnStatus
  count?: number
  comparator?: FailOnComparator
}

/**
 * Render a clause back to its `--fail-on` argument form so error messages / logs quote
 * exactly what the user typed. Deterministic — the same clause always produces the same
 * string, which matters for stable test snapshots.
 */
export function formatFailOnClause(clause: FailOnClause): string {
  if (clause.count === undefined || clause.comparator === undefined) return clause.status
  return `${clause.status}:${clause.comparator}${clause.count}`
}

/**
 * Human-readable diagnostic emitted when a gate fires. The design (§6.3 tail /
 * WI-13 AC 5) demands a stable phrasing so the CI log stays greppable:
 *
 *   `--fail-on changed:>10 tripped (observed: 42 changed symbols)`
 *   `--fail-on dropped-toggled tripped (observed: 3 dropped-toggled symbols)`
 *
 * When the clause has no threshold, the "expected" side is omitted because "presence" is
 * itself the trigger.
 */
export function formatFailOnTriggered(clause: FailOnClause, observed: number): string {
  const bucketLabel = failOnLabel(clause.status)
  return `--fail-on ${formatFailOnClause(clause)} tripped (observed: ${observed} ${bucketLabel} symbols)`
}

function failOnLabel(status: FailOnStatus): string {
  return status
}

/**
 * Evaluate whether a clause is triggered by a Diff summary. Bare-status clauses fire on
 * `observed > 0`; threshold clauses use the operator. The `Summary` key mapping is
 * deliberately explicit (not a dynamic property lookup) so a schema addition can't
 * silently start counting.
 */
export function evaluateFailOn(
  clause: FailOnClause,
  summary: Summary,
  droppedToggledBreakdown: { toDropped: number; toKept: number } = { toDropped: 0, toKept: 0 },
): { triggered: boolean; observed: number } {
  const observed = observedCount(clause.status, summary, droppedToggledBreakdown)
  if (clause.count === undefined || clause.comparator === undefined) {
    return { triggered: observed > 0, observed }
  }
  const cmp = clause.comparator
  const threshold = clause.count
  if (cmp === ">") return { triggered: observed > threshold, observed }
  if (cmp === ">=") return { triggered: observed >= threshold, observed }
  if (cmp === "==") return { triggered: observed === threshold, observed }
  return { triggered: observed <= threshold, observed }
}

function observedCount(
  status: FailOnStatus,
  summary: Summary,
  droppedToggledBreakdown: { toDropped: number; toKept: number },
): number {
  switch (status) {
    case "added":
      return summary.added
    case "removed":
      return summary.removed
    case "changed":
      return summary.changed
    case "moved":
      return summary.moved
    case "moved+changed":
      return summary.movedChanged
    case "dropped-toggled":
      return summary.droppedToggled
    case "dropped-toggled:to-dropped":
      return droppedToggledBreakdown.toDropped
    case "dropped-toggled:to-kept":
      return droppedToggledBreakdown.toKept
  }
}
