import type { DiffResult, SymbolChange, SymbolChanged, SymbolMovedChanged } from "@aburi/types"

/**
 * §6.7 — `--fail-on` value grammar. Three families collapse into one union so the CLI
 * driver can accept a comma-separated list without branching per family.
 *
 * Status family (raw `SymbolChange["status"]` plus direction subtypes):
 *   added / removed / changed / moved / moved+changed / dropped-toggled
 *   dropped-toggled:to-dropped / dropped-toggled:to-kept
 *
 * Delta axis family (subtype of `status: "changed" | "moved+changed"`):
 *   api-changed / logic-changed / syntax-changed
 *
 * Every value may carry a count threshold: `<value>:><N>` triggers only when observed
 * count exceeds N (strict greater-than). The design lists `>` as the only comparator in
 * v0.1; other operators are reserved for a future extension.
 */
export type FailOnStatusToken =
  | "added"
  | "removed"
  | "changed"
  | "moved"
  | "moved+changed"
  | "dropped-toggled"
  | "dropped-toggled:to-dropped"
  | "dropped-toggled:to-kept"

export type FailOnDeltaAxis = "api-changed" | "logic-changed" | "syntax-changed"

export type FailOnToken = FailOnStatusToken | FailOnDeltaAxis

export interface FailOnClause {
  token: FailOnToken
  /** `null` when the clause is bare (fires on `observed > 0`); the numeric bound otherwise. */
  threshold: number | null
}

const STATUS_TOKENS: ReadonlySet<FailOnStatusToken> = new Set([
  "added",
  "removed",
  "changed",
  "moved",
  "moved+changed",
  "dropped-toggled",
  "dropped-toggled:to-dropped",
  "dropped-toggled:to-kept",
])

const DELTA_TOKENS: ReadonlySet<FailOnDeltaAxis> = new Set([
  "api-changed",
  "logic-changed",
  "syntax-changed",
])

export class FailOnParseError extends Error {
  readonly value: string
  constructor(value: string, reason: string) {
    super(`--fail-on value "${value}" is invalid: ${reason}`)
    this.name = "FailOnParseError"
    this.value = value
  }
}

/**
 * Parse the raw `--fail-on` argument (comma-separated). Returns one clause per token.
 * Empty intra-list segments (`--fail-on changed,,removed`) are tolerated so users can
 * build the list programmatically without stripping trailing commas — but a value that
 * yields zero clauses in total is rejected with `FailOnParseError`. The CLI treats
 * `--fail-on ""` (from an unset shell variable, for example) as a configuration mistake
 * rather than "gate disabled": a silently-empty gate would let regressions through with
 * a green exit code, which is the opposite of what a fail-on gate exists to prevent.
 */
export function parseFailOn(value: string): FailOnClause[] {
  const clauses = value
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => parseSingle(segment))
  if (clauses.length === 0) {
    throw new FailOnParseError(
      value,
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    )
  }
  return clauses
}

function parseSingle(segment: string): FailOnClause {
  const colonIdx = findThresholdColon(segment)
  if (colonIdx === -1) {
    return { token: parseToken(segment, segment), threshold: null }
  }
  const tokenPart = segment.slice(0, colonIdx)
  const rest = segment.slice(colonIdx + 1)
  if (!rest.startsWith(">")) {
    throw new FailOnParseError(
      segment,
      `threshold must use ">N" form (e.g. changed:>10); got "${rest}"`,
    )
  }
  const numberPart = rest.slice(1)
  const parsed = Number.parseInt(numberPart, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== numberPart) {
    throw new FailOnParseError(
      segment,
      `threshold must be a non-negative integer; got "${numberPart}"`,
    )
  }
  return { token: parseToken(tokenPart, segment), threshold: parsed }
}

/**
 * Locate the colon that introduces the `:>N` threshold. `dropped-toggled:to-kept` also
 * carries a colon which belongs to the token, so we split on the LAST colon and only
 * accept it if the right side starts with `>`. Otherwise the token itself contains a
 * colon (direction subtype) and no threshold is present.
 */
function findThresholdColon(segment: string): number {
  const last = segment.lastIndexOf(":")
  if (last === -1) return -1
  if (segment[last + 1] !== ">") return -1
  return last
}

function parseToken(raw: string, wholeSegment: string): FailOnToken {
  if (STATUS_TOKENS.has(raw as FailOnStatusToken)) return raw as FailOnStatusToken
  if (DELTA_TOKENS.has(raw as FailOnDeltaAxis)) return raw as FailOnDeltaAxis
  throw new FailOnParseError(wholeSegment, `unknown token "${raw}"`)
}

/**
 * Evaluate a single clause against a DiffResult. `triggered` is `true` when the clause
 * would fire the CI gate; `observed` reports the raw count so error messages can quote
 * "observed: 42 changed symbols".
 */
export function evaluateClause(
  clause: FailOnClause,
  diff: DiffResult,
): { triggered: boolean; observed: number } {
  const observed = countMatches(clause.token, diff)
  const triggered = clause.threshold === null ? observed > 0 : observed > clause.threshold
  return { triggered, observed }
}

/**
 * Evaluate every clause. Returns the first-triggered clause + observed count for the
 * error message, plus a list of every clause's observed count so the caller can decide
 * how verbose to be. When nothing fires, `firstTriggered` is `null`.
 */
export function evaluateFailOn(
  clauses: readonly FailOnClause[],
  diff: DiffResult,
): {
  firstTriggered: { clause: FailOnClause; observed: number } | null
  evaluations: { clause: FailOnClause; observed: number; triggered: boolean }[]
} {
  const evaluations = clauses.map((clause) => ({ clause, ...evaluateClause(clause, diff) }))
  const first = evaluations.find((e) => e.triggered)
  return {
    firstTriggered: first === undefined ? null : { clause: first.clause, observed: first.observed },
    evaluations,
  }
}

function countMatches(token: FailOnToken, diff: DiffResult): number {
  const summary = diff.summary
  switch (token) {
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
      return diff.symbols.filter(
        (s) => s.status === "dropped-toggled" && s.direction === "to-dropped",
      ).length
    case "dropped-toggled:to-kept":
      return diff.symbols.filter((s) => s.status === "dropped-toggled" && s.direction === "to-kept")
        .length
    case "api-changed":
      return countDeltaAxis(diff.symbols, "apiChanged")
    case "logic-changed":
      return countDeltaAxis(diff.symbols, "logicChanged")
    case "syntax-changed":
      return countDeltaAxis(diff.symbols, "syntaxChanged")
    default:
      return assertNever(token)
  }
}

function countDeltaAxis(
  changes: readonly SymbolChange[],
  axis: "apiChanged" | "logicChanged" | "syntaxChanged",
): number {
  let count = 0
  for (const c of changes) {
    if (c.status !== "changed" && c.status !== "moved+changed") continue
    const delta = (c as SymbolChanged | SymbolMovedChanged).delta
    if (delta[axis]) count++
  }
  return count
}

function assertNever(value: never): never {
  throw new Error(`Unhandled FailOnToken: ${JSON.stringify(value)}`)
}

/**
 * Human-readable phrasing for a triggered clause (matches the design's CI log guidance:
 * "aburi diff --fail-on ... tripped"). Callers concat this before piping to `stderr`.
 */
export function formatTriggered(clause: FailOnClause, observed: number): string {
  const rendered = clause.threshold === null ? clause.token : `${clause.token}:>${clause.threshold}`
  return `--fail-on ${rendered} tripped (observed: ${observed} ${clause.token})`
}
