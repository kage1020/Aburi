import type { DiffResult, SymbolChange, SymbolChanged, SymbolMovedChanged } from "@aburi/types"
import { assertNever } from "./errors"

/**
 * `cli-spec.md` — `--fail-on` value grammar. Three families collapse into one union so the CLI
 * driver can accept a comma-separated list without branching per family.
 *
 * Status family (raw `SymbolChange["status"]` plus direction subtypes):
 *   added / removed / changed / moved / moved+changed / dropped-toggled / unknown
 *   dropped-toggled:to-dropped / dropped-toggled:to-kept
 *
 * Delta axis family (subtype of `status: "changed" | "moved+changed"`):
 *   api-changed / logic-changed / syntax-changed / confidence-changed
 *
 * Every value may carry a count threshold: `<value>:><N>` triggers only when observed
 * count exceeds N (strict greater-than). The design lists `>` as the only comparator in
 * today; other operators are reserved for a future extension.
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
  | "unknown"

export type FailOnDeltaAxis =
  | "api-changed"
  | "logic-changed"
  | "syntax-changed"
  | "confidence-changed"

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
  "unknown",
])

const DELTA_TOKENS: ReadonlySet<FailOnDeltaAxis> = new Set([
  "api-changed",
  "logic-changed",
  "syntax-changed",
  "confidence-changed",
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
 * Parse the raw `--fail-on` argument (comma-separated) into one clause per segment, or throw
 * `FailOnParseError` naming the whole value as typed. A value with no clause at all (`""`, `","`,
 * `",,"`, from an unset shell variable for example) is refused first, because a silently-empty
 * gate would let regressions through with a green exit code. Otherwise every segment has to be a
 * clause: an empty one (`changed,,removed`, a trailing comma) is refused, since it is as likely a
 * clause that went missing as a stray comma.
 */
export function parseFailOn(value: string): FailOnClause[] {
  const segments = value.split(",").map((segment) => segment.trim())
  if (segments.every((segment) => segment.length === 0)) {
    throw new FailOnParseError(
      value,
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    )
  }
  return segments.map((segment, index) => {
    // Which clause, when there is more than one to choose from.
    const where = segments.length === 1 ? "" : `clause ${index + 1} of ${segments.length}`
    if (segment.length === 0) {
      throw new FailOnParseError(
        value,
        `${where} is empty; remove the extra comma or write the clause.`,
      )
    }
    try {
      return parseSingle(segment)
    } catch (err) {
      if (!(err instanceof ClauseError)) throw err
      throw new FailOnParseError(value, where === "" ? err.message : `${where}: ${err.message}`)
    }
  })
}

/** A clause's own fault, before `parseFailOn` says which clause of which value it was. */
class ClauseError extends Error {}

function parseSingle(segment: string): FailOnClause {
  const colonIdx = findThresholdColon(segment)
  if (colonIdx === -1) {
    // `changed:5` and `changed:<5` are a known token and a threshold missing its `>`, not an
    // unknown token. A word after the colon is left to read as a misspelt token.
    const last = segment.lastIndexOf(":")
    const tail = segment.slice(last + 1)
    if (last !== -1 && /^[\d<=>!]/.test(tail) && isToken(segment.slice(0, last))) {
      throw new ClauseError(`threshold must use ">N" form (e.g. changed:>10); got "${tail}"`)
    }
    return { token: parseToken(segment), threshold: null }
  }
  const tokenPart = segment.slice(0, colonIdx)
  const numberPart = segment.slice(colonIdx + 2)
  if (/^[<=>!]/.test(numberPart)) {
    throw new ClauseError(
      `threshold must use ">N" form (e.g. changed:>10); got "${segment.slice(colonIdx + 1)}"`,
    )
  }
  const parsed = Number.parseInt(numberPart, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== numberPart) {
    throw new ClauseError(`threshold must be a non-negative integer; got "${numberPart}"`)
  }
  return { token: parseToken(tokenPart), threshold: parsed }
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

function isToken(raw: string): raw is FailOnToken {
  return STATUS_TOKENS.has(raw as FailOnStatusToken) || DELTA_TOKENS.has(raw as FailOnDeltaAxis)
}

function parseToken(raw: string): FailOnToken {
  if (isToken(raw)) return raw
  throw new ClauseError(`unknown token "${raw}"`)
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
    case "unknown":
      // Counted off the entries rather than off `summary.unknown`, which is optional: a
      // diff written before the counter existed carries neither, and one written after
      // carries both. Reading the list keeps the gate answering about what is in the
      // document rather than about which writer produced it.
      //
      // `@aburi/markdown-projection`'s `observedCount` reads the counter instead, because it
      // is handed only a `Summary`. The two agree for anything `buildDiff` wrote; nothing
      // enforces that they agree for a document written by hand.
      return diff.symbols.filter((s) => s.status === "unknown").length
    case "api-changed":
      return countDeltaAxis(diff.symbols, "apiChanged")
    case "logic-changed":
      return countDeltaAxis(diff.symbols, "logicChanged")
    case "syntax-changed":
      return countDeltaAxis(diff.symbols, "syntaxChanged")
    case "confidence-changed":
      return countDeltaAxis(diff.symbols, "confidenceChanged")
    default:
      return assertNever(token, "FailOnToken")
  }
}

function countDeltaAxis(
  changes: readonly SymbolChange[],
  axis: "apiChanged" | "logicChanged" | "syntaxChanged" | "confidenceChanged",
): number {
  let count = 0
  for (const c of changes) {
    if (c.status !== "changed" && c.status !== "moved+changed") continue
    const delta = (c as SymbolChanged | SymbolMovedChanged).delta
    if (delta[axis]) count++
  }
  return count
}

/**
 * Human-readable phrasing for a triggered clause (matches the design's CI log guidance:
 * "aburi diff --fail-on ... tripped"). Callers concat this before piping to `stderr`.
 */
export function formatTriggered(clause: FailOnClause, observed: number): string {
  const rendered = clause.threshold === null ? clause.token : `${clause.token}:>${clause.threshold}`
  return `--fail-on ${rendered} tripped (observed: ${observed} ${clause.token})`
}
