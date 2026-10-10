import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { dependencyKey } from "./call-site"
import type { IntegrityViolation } from "./errors"
import { compareCodeUnit } from "./order"

export function checkArraySortOrder(ir: IR, out: IntegrityViolation[]): void {
  assertSorted(
    ir.components.map((c) => c.id),
    "components[]",
    out,
  )
  assertSorted(
    ir.symbols.map((s) => s.id),
    "symbols[]",
    out,
  )
  assertSorted(
    (ir.stats.skippedFiles ?? []).map((f) => f.path),
    "stats.skippedFiles[]",
    out,
  )
  assertSorted(
    ir.dependencies.map((d) => dependencyKey(d.from, d.to, d.via)),
    "dependencies[]",
    out,
  )
  for (const symbol of ir.symbols) {
    const at = `symbols[id=${symbol.id}]`
    assertLinesSorted(
      symbol.decorators.map((d) => d.line),
      `${at}.decorators[].line`,
      out,
    )
    assertLinesSorted(
      symbol.rules.map((r) => r.line),
      `${at}.rules[].line`,
      out,
    )
    assertEffectSegmentation(symbol, out)
    assertLinesSorted(
      symbol.calls.map((c) => c.line),
      `${at}.calls[].line`,
      out,
    )
  }
}

function assertSorted(
  values: readonly string[],
  collection: string,
  out: IntegrityViolation[],
): void {
  reportFirstDescent(
    values,
    compareCodeUnit,
    collection,
    out,
    (prev, curr) => `"${prev}" precedes "${curr}"`,
  )
}

function assertLinesSorted(
  lines: readonly number[],
  collection: string,
  out: IntegrityViolation[],
): void {
  reportFirstDescent(
    lines,
    (a, b) => a - b,
    collection,
    out,
    (prev, curr) => `line ${prev} precedes ${curr}`,
  )
}

function reportFirstDescent<T>(
  values: readonly T[],
  compare: (a: T, b: T) => number,
  collection: string,
  out: IntegrityViolation[],
  describePair: (prev: T, curr: T) => string,
): void {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] as T
    const curr = values[i] as T
    if (compare(prev, curr) <= 0) continue
    out.push({
      invariant: 11,
      subject: collection,
      message: `${collection} not sorted: ${describePair(prev, curr)}`,
    })
    return
  }
}

function assertEffectSegmentation(symbol: IRSymbol, out: IntegrityViolation[]): void {
  const subject = `symbols[id=${symbol.id}].effects[]`
  const report = (message: string) =>
    out.push({ invariant: 11, subject, message: `${subject}: ${message}` })
  const firstPropagated = symbol.effects.findIndex((e) => e.propagated === true)
  const localAfterPropagated =
    firstPropagated < 0
      ? undefined
      : symbol.effects.slice(firstPropagated + 1).find((e) => e.propagated !== true)
  if (localAfterPropagated !== undefined) {
    report(
      `locally-detected entry appears after a propagated entry (${localAfterPropagated.id}/${localAfterPropagated.target})`,
    )
  }
  const localLines: number[] = []
  const propagatedKeys: string[] = []
  for (const effect of symbol.effects) {
    const pair = `${effect.id}/${effect.target}`
    if (effect.propagated === true) {
      if (effect.line !== undefined) {
        report(
          `propagated entry (${pair}) carries line=${effect.line}; propagated entries must omit line`,
        )
      }
      if (effect.derivedFrom === undefined || effect.derivedFrom.length === 0) {
        report(`propagated entry (${pair}) missing non-empty derivedFrom`)
      }
      propagatedKeys.push(`${effect.id}\t${effect.target}`)
    } else if (effect.line === undefined) {
      report(`locally-detected entry (${pair}) missing line`)
    } else {
      localLines.push(effect.line)
    }
  }
  assertLinesSorted(localLines, `${subject}/local.line`, out)
  assertSorted(propagatedKeys, `${subject}/propagated(id,target)`, out)
}
