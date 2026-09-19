import { stringArraysEqual } from "@aburi/core"
import type {
  ArrayDelta,
  Call,
  Decorator,
  Effect,
  Symbol as IRSymbol,
  Rule,
  Signature,
  SignatureDelta,
  SymbolDelta,
} from "@aburi/types"
import { DiffError } from "./errors"

export const DEFAULT_LINE_FUZZ = 2
export const MAX_LINE_FUZZ = 10
export const MIN_LINE_FUZZ = 0

export interface DeltaOptions {
  /**
   * Line fuzz for rule/call identity (diff-algorithm.md). Must be an integer in
   * `[MIN_LINE_FUZZ, MAX_LINE_FUZZ]` (`0..10`); anything outside — or a non-finite value —
   * throws `DiffError({ code: "invalid-line-fuzz" })`. Setting `0` disables fuzz; omitting
   * the field falls back to `DEFAULT_LINE_FUZZ` (2).
   */
  lineFuzz?: number
}

/**
 * The full per-Symbol delta between two paired Symbols (diff-algorithm.md). The axis booleans
 * come from fingerprint comparison; the array deltas from identity-preserving diff with line
 * fuzz.
 */
export function computeSymbolDelta(
  base: IRSymbol,
  head: IRSymbol,
  options: DeltaOptions = {},
): SymbolDelta {
  const fuzz = validateLineFuzz(options.lineFuzz ?? DEFAULT_LINE_FUZZ)
  return {
    apiChanged: base.fingerprint.api !== head.fingerprint.api,
    logicChanged: base.fingerprint.logic !== head.fingerprint.logic,
    syntaxChanged: base.fingerprint.syntax !== head.fingerprint.syntax,
    componentChanged: (base.component ?? null) !== (head.component ?? null),
    visibilityChanged: base.visibility !== head.visibility,
    rules: diffRules(base.rules, head.rules, fuzz),
    effects: diffEffects(base.effects, head.effects),
    calls: diffCalls(base.calls, head.calls, fuzz),
    decorators: diffDecorators(base.decorators, head.decorators, fuzz),
    signature: diffSignature(base.signature ?? null, head.signature ?? null),
  }
}

/**
 * Line-fuzz range check (diff-algorithm.md). Loud rather than clamping so a config typo
 * (`lineFuzz: 999`) or an upstream `NaN` surfaces at the diff boundary instead of rounding
 * into the wrong deltas.
 */
function validateLineFuzz(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new DiffError(
      `config.diff.lineFuzz must be an integer in [${MIN_LINE_FUZZ}, ${MAX_LINE_FUZZ}]; got ${String(value)}.`,
      { code: "invalid-line-fuzz", value: String(value) },
    )
  }
  if (value < MIN_LINE_FUZZ || value > MAX_LINE_FUZZ) {
    throw new DiffError(
      `config.diff.lineFuzz must be within [${MIN_LINE_FUZZ}, ${MAX_LINE_FUZZ}]; got ${value}.`,
      { code: "invalid-line-fuzz", value: String(value) },
    )
  }
  return value
}

interface Identified<T> {
  item: T
  key: string
  line: number
}

/**
 * Array diff (diff-algorithm.md) — pair the two sides by identity key within ±`lineFuzz`,
 * then classify each element into `added` / `removed` / `modified`. `modified` fires only
 * when a pairing holds and the content differs, so a cosmetic line shift produces nothing.
 *
 * Several elements of one Symbol routinely share a key — two `guard` rules, two `@Get` — so
 * which base element a head element takes is a real choice. Two passes make it:
 * first the elements whose key **and content** agree, then whatever is left. An untouched
 * element is therefore claimed by its own counterpart before an edited or deleted neighbour
 * can take it, and the remainder pairs by proximity, where a genuine edit lands.
 *
 * Each pass is an order-preserving assignment rather than a per-element search, because a
 * greedy pass can take a pairing that leaves a better set unreachable: two identical guards
 * shifted down two lines would come back as an `added` and a `removed`.
 */
function classifyArrayDelta<T>(
  base: readonly Identified<T>[],
  head: readonly Identified<T>[],
  isEqual: (a: T, b: T) => boolean,
  lineFuzz: number,
): ArrayDelta {
  const freeBase = new Set(base.map((_, index) => index))
  const freeHead = new Set(head.map((_, index) => index))
  const partnerOf = new Map<number, Identified<T>>()
  for (const contentMustAgree of [true, false]) {
    const admits = (b: Identified<T>, h: Identified<T>): boolean =>
      b.key === h.key &&
      Math.abs(b.line - h.line) <= lineFuzz &&
      (!contentMustAgree || isEqual(b.item, h.item))
    for (const [baseIndex, headIndex] of assignInOrder(base, head, freeBase, freeHead, admits)) {
      freeBase.delete(baseIndex)
      freeHead.delete(headIndex)
      const counterpart = base[baseIndex]
      if (counterpart !== undefined) partnerOf.set(headIndex, counterpart)
    }
  }

  const added: T[] = []
  const modified: T[] = []
  for (const [index, h] of head.entries()) {
    const counterpart = partnerOf.get(index)
    if (counterpart === undefined) added.push(h.item)
    else if (!isEqual(counterpart.item, h.item)) modified.push(h.item)
  }
  const removed = base.filter((_, index) => freeBase.has(index)).map((b) => b.item)
  return { added, removed, modified }
}

/** How good an assignment is: more pairings first, then less total line movement. */
interface AssignmentScore {
  pairs: number
  distance: number
}

const EMPTY_ASSIGNMENT: AssignmentScore = { pairs: 0, distance: 0 }

function outranks(a: AssignmentScore, b: AssignmentScore): boolean {
  return a.pairs !== b.pairs ? a.pairs > b.pairs : a.distance < b.distance
}

/**
 * The best set of non-crossing pairings between the still-free elements of `base` and `head`,
 * as `[baseIndex, headIndex]` in ascending order.
 *
 * Non-crossing is the whole content of the rule, and ir-schema.md #11 licenses it: these
 * arrays are ordered by line, so two pairings that cross would have an element move above one
 * it was below, which is a different element rather than a line shift. It also makes the
 * optimum reachable by a suffix recurrence. Maximising the count before minimising distance
 * stops a near pairing from being taken at the cost of a far one that would otherwise have no
 * partner at all.
 */
function assignInOrder<T>(
  base: readonly Identified<T>[],
  head: readonly Identified<T>[],
  freeBase: ReadonlySet<number>,
  freeHead: ReadonlySet<number>,
  admits: (b: Identified<T>, h: Identified<T>) => boolean,
): Array<[number, number]> {
  // best[i][j] is the score of the best assignment over base[i..] and head[j..].
  const best: AssignmentScore[][] = Array.from({ length: base.length + 1 }, () =>
    Array.from({ length: head.length + 1 }, () => EMPTY_ASSIGNMENT),
  )
  const pairingAt = (i: number, j: number): AssignmentScore | null => {
    const b = base[i]
    const h = head[j]
    if (b === undefined || h === undefined) return null
    if (!freeBase.has(i) || !freeHead.has(j) || !admits(b, h)) return null
    const rest = best[i + 1]?.[j + 1] ?? EMPTY_ASSIGNMENT
    return { pairs: rest.pairs + 1, distance: rest.distance + Math.abs(b.line - h.line) }
  }
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = head.length - 1; j >= 0; j--) {
      const skipBase = best[i + 1]?.[j] ?? EMPTY_ASSIGNMENT
      const skipHead = best[i]?.[j + 1] ?? EMPTY_ASSIGNMENT
      let winner = outranks(skipBase, skipHead) ? skipBase : skipHead
      const paired = pairingAt(i, j)
      if (paired !== null && outranks(paired, winner)) winner = paired
      const row = best[i]
      if (row !== undefined) row[j] = winner
    }
  }

  // Walk the table back down, taking a pairing wherever it is what the optimum was built from.
  const chosen: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < base.length && j < head.length) {
    const here = best[i]?.[j] ?? EMPTY_ASSIGNMENT
    const paired = pairingAt(i, j)
    if (paired !== null && paired.pairs === here.pairs && paired.distance === here.distance) {
      chosen.push([i, j])
      i++
      j++
      continue
    }
    const skipBase = best[i + 1]?.[j] ?? EMPTY_ASSIGNMENT
    if (skipBase.pairs === here.pairs && skipBase.distance === here.distance) i++
    else j++
  }
  return chosen
}

function diffRules(base: readonly Rule[], head: readonly Rule[], lineFuzz: number): ArrayDelta {
  const mapper = (rule: Rule): Identified<Rule> => ({ item: rule, key: rule.type, line: rule.line })
  return classifyArrayDelta(base.map(mapper), head.map(mapper), rulesEqual, lineFuzz)
}

function rulesEqual(a: Rule, b: Rule): boolean {
  return (
    a.type === b.type &&
    (a.condition ?? null) === (b.condition ?? null) &&
    (a.what ?? null) === (b.what ?? null) &&
    (a.expr ?? null) === (b.expr ?? null) &&
    (a.loopKind ?? null) === (b.loopKind ?? null)
  )
}

function diffEffects(base: readonly Effect[], head: readonly Effect[]): ArrayDelta {
  const mapper = (effect: Effect): Identified<Effect> => ({
    item: effect,
    key: `${effect.id}::${effect.target}`,
    // Propagated entries (effect-propagation.md) omit `line`. The infinite fuzz admits
    // every same-key candidate, and `(id, target)` is the whole of an effect's identity
    // (ir-schema.md), so `0` only ranks a propagated effect nearest the earliest local one
    // carrying its key; the exact-content pass settles the rest.
    line: effect.line ?? 0,
  })
  return classifyArrayDelta(
    base.map(mapper),
    head.map(mapper),
    effectsEqual,
    Number.POSITIVE_INFINITY,
  )
}

function effectsEqual(a: Effect, b: Effect): boolean {
  return (
    a.id === b.id && a.target === b.target && a.plugin === b.plugin && a.confidence === b.confidence
  )
}

function diffCalls(base: readonly Call[], head: readonly Call[], lineFuzz: number): ArrayDelta {
  const mapper = (call: Call): Identified<Call> => ({
    item: call,
    key: call.target,
    line: call.line,
  })
  return classifyArrayDelta(base.map(mapper), head.map(mapper), callsEqual, lineFuzz)
}

function callsEqual(a: Call, b: Call): boolean {
  return a.target === b.target && (a.resolved ?? null) === (b.resolved ?? null)
}

/** Decorator identity is `name`; the argument list decides `modified` (diff-algorithm.md). */
function diffDecorators(
  base: readonly Decorator[],
  head: readonly Decorator[],
  lineFuzz: number,
): ArrayDelta {
  const mapper = (decorator: Decorator): Identified<Decorator> => ({
    item: decorator,
    key: decorator.name,
    line: decorator.line,
  })
  return classifyArrayDelta(base.map(mapper), head.map(mapper), decoratorsEqual, lineFuzz)
}

function decoratorsEqual(a: Decorator, b: Decorator): boolean {
  return a.name === b.name && stringArraysEqual(a.arguments, b.arguments)
}

/**
 * Signature delta (diff-algorithm.md). Both `null` → `null`; one `null` → the present side
 * emitted verbatim as `added` or `removed`; both present → per-list sub-deltas: `inputs`
 * positional (index in the key, fuzz 0), `outputs` positional without `modified`, `throws`
 * as a set.
 */
function diffSignature(base: Signature | null, head: Signature | null): SignatureDelta | null {
  if (base === null) return head === null ? null : oneSidedSignatureDelta(head, "added")
  if (head === null) return oneSidedSignatureDelta(base, "removed")
  // Parameters are positional, so the index is part of the identity and the fuzz is 0. Every
  // key is then unique within its list, so the pairing never has a choice to make here.
  const inputMapper = (
    input: { name: string; type: string },
    index: number,
  ): Identified<{ name: string; type: string }> => ({
    item: input,
    key: `${index}:${input.name}`,
    line: index,
  })
  const inputs = classifyArrayDelta(
    base.inputs.map(inputMapper),
    head.inputs.map(inputMapper),
    (a, b) => a.name === b.name && a.type === b.type,
    0,
  )
  return {
    inputs,
    outputs: diffStringList(base.outputs, head.outputs),
    throws: diffStringSet(base.throws, head.throws),
    asyncChanged: base.async !== head.async,
    generatorChanged: base.generator !== head.generator,
    typeParametersChanged: !stringArraysEqual(base.typeParameters, head.typeParameters),
  }
}

/** The delta against a missing side: every list lands whole in `bucket`, flags against defaults. */
function oneSidedSignatureDelta(present: Signature, bucket: "added" | "removed"): SignatureDelta {
  const whole = (values: readonly unknown[]): ArrayDelta => ({
    added: bucket === "added" ? [...values] : [],
    removed: bucket === "removed" ? [...values] : [],
    modified: [],
  })
  return {
    inputs: whole(present.inputs),
    outputs: whole(present.outputs),
    throws: whole(present.throws),
    asyncChanged: present.async,
    generatorChanged: present.generator,
    typeParametersChanged: present.typeParameters.length > 0,
  }
}

function diffStringList(base: readonly string[], head: readonly string[]): ArrayDelta {
  const added: string[] = []
  const removed: string[] = []
  const max = Math.max(base.length, head.length)
  for (let i = 0; i < max; i++) {
    const b = i < base.length ? base[i] : undefined
    const h = i < head.length ? head[i] : undefined
    if (b === undefined && h !== undefined) added.push(h)
    else if (h === undefined && b !== undefined) removed.push(b)
    else if (b !== h) {
      if (b !== undefined) removed.push(b)
      if (h !== undefined) added.push(h)
    }
  }
  return { added, removed, modified: [] }
}

function diffStringSet(base: readonly string[], head: readonly string[]): ArrayDelta {
  const setB = new Set(base)
  const setH = new Set(head)
  const added: string[] = []
  const removed: string[] = []
  for (const h of setH) if (!setB.has(h)) added.push(h)
  for (const b of setB) if (!setH.has(b)) removed.push(b)
  return { added, removed, modified: [] }
}
