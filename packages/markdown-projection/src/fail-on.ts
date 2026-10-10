import type { Summary } from "@aburi/types"

export type FailOnStatus =
  | "added"
  | "removed"
  | "changed"
  | "moved"
  | "moved+changed"
  | "dropped-toggled"
  | "dropped-toggled:to-dropped"
  | "dropped-toggled:to-kept"
  | "unknown"

export const FAIL_ON_STATUSES = [
  "added",
  "removed",
  "changed",
  "moved",
  "moved+changed",
  "dropped-toggled",
  "dropped-toggled:to-dropped",
  "dropped-toggled:to-kept",
  "unknown",
] as const satisfies readonly FailOnStatus[]

export type FailOnComparator = ">" | ">=" | "==" | "<="

export type FailOnClause =
  | { kind: "bare"; status: FailOnStatus }
  | {
      kind: "threshold"
      status: FailOnStatus
      comparator: FailOnComparator
      count: number
    }

export interface DroppedToggledBreakdown {
  toDropped: number
  toKept: number
}

export function formatFailOnClause(clause: FailOnClause): string {
  if (clause.kind === "bare") return clause.status
  return `${clause.status}:${clause.comparator}${clause.count}`
}

export function formatFailOnTriggered(clause: FailOnClause, observed: number): string {
  return `--fail-on ${formatFailOnClause(clause)} tripped (observed: ${observed} ${clause.status} symbols)`
}

export function evaluateFailOn(
  clause: FailOnClause,
  summary: Summary,
  droppedToggledBreakdown?: DroppedToggledBreakdown,
): { triggered: boolean; observed: number } {
  const observed = observedCount(clause.status, summary, droppedToggledBreakdown)
  if (clause.kind === "bare") return { triggered: observed > 0, observed }
  const { comparator, count } = clause
  return { triggered: compare(observed, comparator, count), observed }
}

function compare(observed: number, comparator: FailOnComparator, threshold: number): boolean {
  switch (comparator) {
    case ">":
      return observed > threshold
    case ">=":
      return observed >= threshold
    case "==":
      return observed === threshold
    case "<=":
      return observed <= threshold
    default:
      return assertNeverComparator(comparator)
  }
}

function observedCount(
  status: FailOnStatus,
  summary: Summary,
  droppedToggledBreakdown: DroppedToggledBreakdown | undefined,
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
    case "unknown":
      return summary.unknown ?? 0
    case "dropped-toggled:to-dropped":
      return requireBreakdown(droppedToggledBreakdown, status).toDropped
    case "dropped-toggled:to-kept":
      return requireBreakdown(droppedToggledBreakdown, status).toKept
    default:
      return assertNeverStatus(status)
  }
}

function requireBreakdown(
  breakdown: DroppedToggledBreakdown | undefined,
  status: FailOnStatus,
): DroppedToggledBreakdown {
  if (breakdown === undefined) {
    throw new Error(
      `evaluateFailOn: clause status "${status}" requires droppedToggledBreakdown; supply toDropped/toKept counts to prevent silent zero-observation gates.`,
    )
  }
  return breakdown
}

function assertNeverComparator(value: never): never {
  throw new Error(`Unhandled FailOnComparator: ${JSON.stringify(value)}`)
}

function assertNeverStatus(value: never): never {
  throw new Error(`Unhandled FailOnStatus: ${JSON.stringify(value)}`)
}
