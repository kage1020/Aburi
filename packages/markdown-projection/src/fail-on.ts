import type { Summary } from "@aburi/types"

/**
 * The status buckets a fail-on gate can watch. Mirrors `SymbolChange["status"]` on the
 * diff side plus the two nested `dropped-toggled` directions the design (§4.1) calls out
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
  | "unknown"

/**
 * Every member, as a value. Exported for the tests that walk the union: a matrix written by
 * hand does not break when the union grows, which is how the `unknown` row came to be missing
 * from an "all 8 branches" test that had nine to cover.
 */
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

/** Comparison operator when a numeric threshold is attached (e.g. `changed:>10`). */
export type FailOnComparator = ">" | ">=" | "==" | "<="

/**
 * A fail-on clause. Modelled as a discriminated union so an illegal state where only one
 * of `count` / `comparator` is present cannot compile. A bare status clause fires on
 * "any occurrence"; a threshold clause fires when `observed` satisfies the comparator.
 */
export type FailOnClause =
  | { kind: "bare"; status: FailOnStatus }
  | {
      kind: "threshold"
      status: FailOnStatus
      comparator: FailOnComparator
      count: number
    }

/**
 * Breakdown of `summary.droppedToggled` into the two directions. Required by any clause
 * that names a `dropped-toggled:*` sub-status; the caller must supply it because a plain
 * IR/Diff summary does not carry the split.
 */
export interface DroppedToggledBreakdown {
  toDropped: number
  toKept: number
}

/**
 * Render a clause back to its CLI-argument form so error messages / logs quote exactly
 * what the user typed. Deterministic — the same clause always produces the same string,
 * which matters for stable test snapshots.
 */
export function formatFailOnClause(clause: FailOnClause): string {
  if (clause.kind === "bare") return clause.status
  return `${clause.status}:${clause.comparator}${clause.count}`
}

/**
 * Human-readable diagnostic emitted when a gate fires. The phrasing is fixed so the CI
 * log stays greppable:
 *
 *   `--fail-on changed:>10 tripped (observed: 42 changed symbols)`
 *   `--fail-on dropped-toggled tripped (observed: 3 dropped-toggled symbols)`
 */
export function formatFailOnTriggered(clause: FailOnClause, observed: number): string {
  return `--fail-on ${formatFailOnClause(clause)} tripped (observed: ${observed} ${clause.status} symbols)`
}

/**
 * Evaluate whether a clause is triggered. Bare-status clauses fire on `observed > 0`;
 * threshold clauses use the operator.
 *
 * `droppedToggledBreakdown` is only consulted for `dropped-toggled:*` sub-statuses. It
 * has NO default: passing a clause that names a sub-status without supplying the
 * breakdown throws, because a silent default of `{0, 0}` would let the gate report
 * "no observations" when the caller merely forgot to compute the split — exactly the
 * silent-fallback failure mode the fail-on gate exists to prevent.
 */
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
      // Read off the summary because that is all this function is given — unlike the CLI's
      // `evaluateFailOn`, which holds the whole `DiffResult` and counts the entries. The two
      // agree because `buildDiff` is the only writer of both and there is no diff-side
      // integrity layer tying them together; a hand-authored `diff.json` can disagree, and
      // then this answers about the counter while the CLI answers about the document.
      //
      // `?? 0` rather than the `requireBreakdown` treatment below, which throws for a caller
      // that failed to supply data it could have: absence here is not a caller mistake but a
      // diff written before the counter existed, and a document that cannot report unknowns
      // must not be failed for having them.
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
