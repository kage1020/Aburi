import type { DiffResult, Symbol as IRSymbol, SymbolChange, SymbolId } from "@aburi/types"
import { assertNever } from "./errors"
import { MAX_LISTED } from "./listing"

export type FailOnStatusToken =
  | "added"
  | "removed"
  | "removed:duplicate"
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

export type FailOnScope = "all" | "non-test"

export interface FailOnClause {
  token: FailOnToken
  threshold: number | null
}

const STATUS_TOKENS: ReadonlySet<FailOnStatusToken> = new Set([
  "added",
  "removed",
  "removed:duplicate",
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

export function parseFailOn(value: string): FailOnClause[] {
  const segments = value.split(",").map((segment) => segment.trim())
  if (segments.every((segment) => segment.length === 0)) {
    throw new FailOnParseError(
      value,
      "expected at least one clause; an empty --fail-on value would silently disable the CI gate.",
    )
  }
  return segments.map((segment, index) => {
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

class ClauseError extends Error {}

function parseSingle(segment: string): FailOnClause {
  const colonIdx = findThresholdColon(segment)
  if (colonIdx === -1) {
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

export interface ClauseOutcome {
  triggered: boolean
  observed: number
  symbols: readonly SymbolId[]
}

export function evaluateClause(
  clause: FailOnClause,
  diff: DiffResult,
  scope: FailOnScope = "all",
): ClauseOutcome {
  const symbols = countedIds(clause.token, diff, scope)
  const observed = symbols.length
  const triggered = clause.threshold === null ? observed > 0 : observed > clause.threshold
  return { triggered, observed, symbols }
}

export interface TrippedClause {
  clause: FailOnClause
  observed: number
  symbols: readonly SymbolId[]
  scope: FailOnScope
}

export function evaluateFailOn(
  clauses: readonly FailOnClause[],
  diff: DiffResult,
  scope: FailOnScope = "all",
): {
  firstTriggered: TrippedClause | null
  evaluations: ({ clause: FailOnClause } & ClauseOutcome)[]
} {
  const evaluations = clauses.map((clause) => ({ clause, ...evaluateClause(clause, diff, scope) }))
  const first = evaluations.find((e) => e.triggered)
  return {
    firstTriggered:
      first === undefined
        ? null
        : { clause: first.clause, observed: first.observed, symbols: first.symbols, scope },
    evaluations,
  }
}

function counts(token: FailOnToken, change: SymbolChange): boolean {
  switch (token) {
    case "added":
    case "changed":
    case "moved":
    case "moved+changed":
    case "dropped-toggled":
    case "unknown":
      return change.status === token
    case "removed":
      return change.status === "removed" && (change.duplicateOf ?? null) === null
    case "removed:duplicate":
      return change.status === "removed" && (change.duplicateOf ?? null) !== null
    case "dropped-toggled:to-dropped":
      return change.status === "dropped-toggled" && change.direction === "to-dropped"
    case "dropped-toggled:to-kept":
      return change.status === "dropped-toggled" && change.direction === "to-kept"
    case "api-changed":
      return deltaMoved(change, "apiChanged")
    case "logic-changed":
      return deltaMoved(change, "logicChanged")
    case "syntax-changed":
      return deltaMoved(change, "syntaxChanged")
    case "confidence-changed":
      return deltaMoved(change, "confidenceChanged")
    default:
      return assertNever(token, "FailOnToken")
  }
}

function deltaMoved(
  change: SymbolChange,
  axis: "apiChanged" | "logicChanged" | "syntaxChanged" | "confidenceChanged",
): boolean {
  return (
    (change.status === "changed" || change.status === "moved+changed") &&
    change.delta[axis] === true
  )
}

export function uncountedDuplicates(
  clauses: readonly FailOnClause[],
  diff: DiffResult,
): SymbolId[] {
  const tokens = new Set(clauses.map((clause) => clause.token))
  if (!tokens.has("removed") || tokens.has("removed:duplicate")) return []
  return countedIds("removed:duplicate", diff, "all")
}

function countedIds(token: FailOnToken, diff: DiffResult, scope: FailOnScope): SymbolId[] {
  return diff.symbols
    .filter((change) => inScope(scope, change) && counts(token, change))
    .map((change) => entrySymbol(change).id)
}

/** The head decides for a pair, as it does where the report lists the entry. */
function inScope(scope: FailOnScope, change: SymbolChange): boolean {
  return scope === "all" || entrySymbol(change).inTestFile !== true
}

function entrySymbol(change: SymbolChange): IRSymbol {
  return "symbol" in change ? change.symbol : change.after
}

export function formatTriggered({ clause, observed, symbols, scope }: TrippedClause): string {
  const rendered = clause.threshold === null ? clause.token : `${clause.token}:>${clause.threshold}`
  const named = symbols.slice(0, MAX_LISTED).map((id) => `  ${id}`)
  const unnamed = symbols.length - named.length
  const where = scope === "all" ? "" : " outside test files"
  return [
    `--fail-on ${rendered} tripped (observed: ${observed} ${clause.token}${where})`,
    ...named,
    ...(unnamed > 0 ? [`  … and ${unnamed} more`] : []),
  ].join("\n")
}
