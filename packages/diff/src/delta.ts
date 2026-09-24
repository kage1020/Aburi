import { compareCodeUnit, stringArraysEqual } from "@aburi/core"
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
   * Line fuzz for pairing an edited rule/call/decorator with its predecessor
   * (diff-algorithm.md); an unchanged one pairs however far it moved. Must be an integer in
   * `[MIN_LINE_FUZZ, MAX_LINE_FUZZ]` (`0..10`); anything outside — or a non-finite value —
   * throws `DiffError({ code: "invalid-line-fuzz" })`. Setting `0` pairs an edit only with an
   * element on the same line, and does not stop an unchanged element from pairing; omitting the
   * field falls back to `DEFAULT_LINE_FUZZ` (2).
   */
  lineFuzz?: number
}

/**
 * The full per-Symbol delta between two paired Symbols (diff-algorithm.md). The axis booleans
 * come from fingerprint comparison; the array deltas from identity-preserving pairing, with line
 * fuzz deciding only how far an edited element may sit from the one it replaced.
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
 * Array diff (diff-algorithm.md) — pair the two sides by identity key, then classify each
 * element into `added` / `removed` / `modified`. `modified` fires only when a pairing holds
 * and the content differs, so a line shift on its own produces nothing.
 *
 * Several elements of one Symbol routinely share a key — two `guard` rules, two `@Get` — so
 * which base element a head element takes is a real choice. Two passes make it:
 * first the elements whose key **and content** agree, wherever they sit, then whatever is
 * left, within ±`lineFuzz`. An untouched element is therefore claimed by its own counterpart
 * before an edited or deleted neighbour can take it, however far the body moved, and the
 * remainder pairs by proximity, where a genuine edit lands.
 *
 * The exact pass has no line window because it needs none: non-crossing already stops an
 * element from pairing with one it was never beside, and an absolute distance would refuse
 * exactly the case the pass exists for — an unchanged body that moved further than the
 * window. The window stays on the second pass, where it is all that separates an edit from
 * an unrelated element that happens to share the key.
 *
 * Each pass is an order-preserving assignment rather than a per-element search, because a
 * greedy pass can take a pairing that leaves a better set unreachable: two edited guards
 * shifted down two lines would come back as an edit, an `added` and a `removed`. The order it
 * preserves is the order among elements of one key. Elements of different keys are never
 * candidates for each other, so which sits above which says nothing about identity — a call
 * that moved below a different call is still the same call.
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
  // Each predicate checks the key itself, although the grouping below already guarantees it:
  // for signature inputs the key carries the position and `isEqual` does not, so a pairing
  // reached by any other route would otherwise cross positions with nothing to stop it.
  const passes: Array<(b: Identified<T>, h: Identified<T>) => boolean> = [
    (b, h) => b.key === h.key && isEqual(b.item, h.item),
    (b, h) => b.key === h.key && Math.abs(b.line - h.line) <= lineFuzz,
  ]
  const groups = groupByKey(base, head)
  for (const admits of passes) {
    for (const group of groups) {
      const pairs = assignInOrder(
        group.base.filter((slot) => freeBase.has(slot.index)),
        group.head.filter((slot) => freeHead.has(slot.index)),
        admits,
      )
      for (const [b, h] of pairs) {
        freeBase.delete(b.index)
        freeHead.delete(h.index)
        partnerOf.set(h.index, b.element)
      }
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

/** One element with its position in the whole array, so a pairing needs no index remap. */
interface Slot<T> {
  index: number
  element: Identified<T>
}

/** The elements of each key on either side, in array order; only a shared key pairs. */
function groupByKey<T>(
  base: readonly Identified<T>[],
  head: readonly Identified<T>[],
): Array<{ base: Slot<T>[]; head: Slot<T>[] }> {
  const byKey = new Map<string, { base: Slot<T>[]; head: Slot<T>[] }>()
  const groupOf = (key: string) => {
    let group = byKey.get(key)
    if (group === undefined) {
      group = { base: [], head: [] }
      byKey.set(key, group)
    }
    return group
  }
  for (const [index, element] of base.entries()) groupOf(element.key).base.push({ index, element })
  for (const [index, element] of head.entries()) groupOf(element.key).head.push({ index, element })
  return [...byKey.values()].filter((group) => group.base.length > 0 && group.head.length > 0)
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
 * The best set of non-crossing pairings between `base` and `head` — the still-free elements of
 * one key, which the caller has already grouped — as slot pairs in ascending order.
 *
 * Non-crossing is the whole content of the rule, and ir-schema.md #11 licenses it: these
 * arrays are ordered by line, so two pairings that cross would have an element move above
 * another of its key that it was below, which is a different element rather than a line
 * shift. It also makes the optimum reachable by a suffix recurrence. Maximising the count
 * before minimising distance stops a near pairing from being taken at the cost of a far one
 * that would otherwise have no partner at all.
 */
function assignInOrder<T>(
  base: readonly Slot<T>[],
  head: readonly Slot<T>[],
  admits: (b: Identified<T>, h: Identified<T>) => boolean,
): Array<[Slot<T>, Slot<T>]> {
  // best[i][j] is the score of the best assignment over base[i..] and head[j..].
  const best: AssignmentScore[][] = Array.from({ length: base.length + 1 }, () =>
    Array.from({ length: head.length + 1 }, () => EMPTY_ASSIGNMENT),
  )
  const pairingAt = (
    i: number,
    j: number,
  ): { score: AssignmentScore; pair: [Slot<T>, Slot<T>] } | null => {
    const b = base[i]
    const h = head[j]
    if (b === undefined || h === undefined || !admits(b.element, h.element)) return null
    const rest = best[i + 1]?.[j + 1] ?? EMPTY_ASSIGNMENT
    const distance = rest.distance + Math.abs(b.element.line - h.element.line)
    return { score: { pairs: rest.pairs + 1, distance }, pair: [b, h] }
  }
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = head.length - 1; j >= 0; j--) {
      const skipBase = best[i + 1]?.[j] ?? EMPTY_ASSIGNMENT
      const skipHead = best[i]?.[j + 1] ?? EMPTY_ASSIGNMENT
      let winner = outranks(skipBase, skipHead) ? skipBase : skipHead
      const paired = pairingAt(i, j)?.score
      if (paired !== undefined && outranks(paired, winner)) winner = paired
      const row = best[i]
      if (row !== undefined) row[j] = winner
    }
  }

  // Walk the table back down, taking a pairing wherever it is what the optimum was built from.
  const chosen: Array<[Slot<T>, Slot<T>]> = []
  let i = 0
  let j = 0
  while (i < base.length && j < head.length) {
    const here = best[i]?.[j] ?? EMPTY_ASSIGNMENT
    const paired = pairingAt(i, j)
    if (
      paired !== null &&
      paired.score.pairs === here.pairs &&
      paired.score.distance === here.distance
    ) {
      chosen.push(paired.pair)
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
  // `line` is position rather than content; `derivedBy` is plugin-issued evidence text whose
  // wording may change independently of the effect identity already carried by `plugin`.
  // Readers compare `derivedFrom` as a set so documents from another producer remain tolerant
  // of source ordering, matching effect-propagation.md §5.1's reader rule for `propagated`.
  return (
    a.id === b.id &&
    a.target === b.target &&
    a.plugin === b.plugin &&
    a.confidence === b.confidence &&
    (a.propagated ?? false) === (b.propagated ?? false) &&
    stringArraysEqual(
      [...(a.derivedFrom ?? [])].sort(compareCodeUnit),
      [...(b.derivedFrom ?? [])].sort(compareCodeUnit),
    )
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

/**
 * Decorator identity is `name`; the argument list and the receiver decide `modified`
 * (diff-algorithm.md).
 */
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

/**
 * `qualifier` is compared and `raw` is not. `raw` quotes the source, so comparing it would report
 * a reformat as an edit; `qualifier` is what a framework plugin resolves the decorator through, so
 * `@nest.Post()` → `@tsed.Post()` moves the Symbol's classification and its api fingerprint, and
 * the delta has to say why. A Document written before the field existed omits it on every
 * decorator, which reads as `null` on both sides and reports nothing.
 */
function decoratorsEqual(a: Decorator, b: Decorator): boolean {
  return (
    a.name === b.name &&
    (a.qualifier ?? null) === (b.qualifier ?? null) &&
    stringArraysEqual(a.arguments, b.arguments)
  )
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
