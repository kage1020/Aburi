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
   * §5.2.1 line fuzz for rule/call identity. Must be an integer in
   * `[MIN_LINE_FUZZ, MAX_LINE_FUZZ]` (`0..10`); anything outside — or a non-finite value —
   * throws `DiffError({ code: "invalid-line-fuzz" })`. Setting `0` disables fuzz; omitting
   * the field falls back to `DEFAULT_LINE_FUZZ` (2).
   */
  lineFuzz?: number
}

/**
 * §5 — Compute the full per-Symbol delta between two paired Symbols. The three axis
 * booleans (`apiChanged` / `logicChanged` / `syntaxChanged`) come from fingerprint
 * comparison; the array deltas (`rules` / `effects` / `calls` / `decorators`) come from
 * identity-preserving diff with configurable line fuzz.
 */
export function computeSymbolDelta(
  base: IRSymbol,
  head: IRSymbol,
  options: DeltaOptions = {},
): SymbolDelta {
  const fuzz = validateLineFuzz(options.lineFuzz ?? DEFAULT_LINE_FUZZ)
  const delta: SymbolDelta = {
    apiChanged: base.fingerprint.api !== head.fingerprint.api,
    logicChanged: base.fingerprint.logic !== head.fingerprint.logic,
    syntaxChanged: base.fingerprint.syntax !== head.fingerprint.syntax,
    componentChanged: (base.component ?? null) !== (head.component ?? null),
    visibilityChanged: base.visibility !== head.visibility,
  }
  delta.rules = diffRules(base.rules, head.rules, fuzz)
  delta.effects = diffEffects(base.effects, head.effects)
  delta.calls = diffCalls(base.calls, head.calls, fuzz)
  delta.decorators = diffDecorators(base.decorators, head.decorators, fuzz)
  const sigDelta = diffSignature(base.signature ?? null, head.signature ?? null)
  delta.signature = sigDelta
  return delta
}

/**
 * §5.2.1 range check. Loud on violation rather than silently clamping so a config typo
 * (`lineFuzz: 999`) or an upstream numeric bug (`NaN`, `Infinity`) surfaces at the diff
 * boundary instead of quietly rounding into a range that produces the wrong deltas.
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
 * §5.2 — pair the two sides by identity key within ±`lineFuzz`, then classify each element
 * into `added` / `removed` / `modified`. `modified` fires only when a pairing holds and the
 * content differs, so a cosmetic line shift produces nothing.
 *
 * Several elements of one Symbol routinely share a key — two `guard` rules, two calls to one
 * target, two `@Get` — so which base element a head element takes is a real choice. Two
 * passes make it: first the elements whose key **and content** agree, then whatever is left.
 * An untouched element is therefore claimed by its own counterpart before an edited or
 * deleted neighbour can take it, and the remainder pairs by proximity — where a genuine edit
 * lands. Taking the first key hit instead reported a deleted `guard@1` by removing its
 * untouched `guard@3` neighbour *and* listing that same neighbour as modified.
 *
 * Each pass is an order-preserving assignment rather than a per-element search, because a
 * greedy pass takes a pairing that leaves a better set unreachable. Two identical guards
 * shifted down two lines are the smallest case: the first head element is nearest to the
 * *second* base element, and claiming it strands the other head outside the window, so a
 * block that moved intact comes back as an `added` and a `removed`.
 */
function differentiate<T>(
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
interface Quality {
  pairs: number
  distance: number
}

const NO_PAIRINGS: Quality = { pairs: 0, distance: 0 }

/** `a` is preferred over `b`: more pairings wins, and among equals the tighter one does. */
function better(a: Quality, b: Quality): boolean {
  return a.pairs !== b.pairs ? a.pairs > b.pairs : a.distance < b.distance
}

/**
 * The best set of non-crossing pairings between the still-free elements of `base` and `head`,
 * as `[baseIndex, headIndex]` in ascending order — most pairings first, then least total line
 * movement.
 *
 * Non-crossing is the whole content of the rule, and ir-schema §14 #11 is what licenses it:
 * these arrays are ordered by line, so `i < j` means element `i` sits above element `j` in the
 * file. Two pairings that cross would have an element move above one it was below, which is
 * not a line shift — it is a different element. Restricting to non-crossing sets also makes
 * the optimum reachable by a suffix recurrence rather than by a general assignment algorithm.
 *
 * Maximising the count before minimising distance is what stops a near pairing from being
 * taken at the cost of a far one that would otherwise have no partner at all.
 */
function assignInOrder<T>(
  base: readonly Identified<T>[],
  head: readonly Identified<T>[],
  freeBase: ReadonlySet<number>,
  freeHead: ReadonlySet<number>,
  admits: (b: Identified<T>, h: Identified<T>) => boolean,
): Array<[number, number]> {
  // best[i][j] is the quality of the best assignment over base[i..] and head[j..].
  const best: Quality[][] = Array.from({ length: base.length + 1 }, () =>
    Array.from({ length: head.length + 1 }, () => NO_PAIRINGS),
  )
  const pairingAt = (i: number, j: number): Quality | null => {
    const b = base[i]
    const h = head[j]
    if (b === undefined || h === undefined) return null
    if (!freeBase.has(i) || !freeHead.has(j) || !admits(b, h)) return null
    const rest = best[i + 1]?.[j + 1] ?? NO_PAIRINGS
    return { pairs: rest.pairs + 1, distance: rest.distance + Math.abs(b.line - h.line) }
  }
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = head.length - 1; j >= 0; j--) {
      const skipBase = best[i + 1]?.[j] ?? NO_PAIRINGS
      const skipHead = best[i]?.[j + 1] ?? NO_PAIRINGS
      let winner = better(skipBase, skipHead) ? skipBase : skipHead
      const paired = pairingAt(i, j)
      if (paired !== null && better(paired, winner)) winner = paired
      const row = best[i]
      if (row !== undefined) row[j] = winner
    }
  }

  // Walk the table back down, taking a pairing wherever it is what the optimum was built from.
  const chosen: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < base.length && j < head.length) {
    const here = best[i]?.[j] ?? NO_PAIRINGS
    const paired = pairingAt(i, j)
    if (paired !== null && paired.pairs === here.pairs && paired.distance === here.distance) {
      chosen.push([i, j])
      i++
      j++
      continue
    }
    const skipBase = best[i + 1]?.[j] ?? NO_PAIRINGS
    if (skipBase.pairs === here.pairs && skipBase.distance === here.distance) i++
    else j++
  }
  return chosen
}

function diffRules(base: readonly Rule[], head: readonly Rule[], lineFuzz: number): ArrayDelta {
  const mapper = (r: Rule): Identified<Rule> => ({
    item: r,
    key: r.type,
    line: r.line,
  })
  return differentiate(base.map(mapper), head.map(mapper), rulesEqual, lineFuzz)
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
  const mapper = (e: Effect): Identified<Effect> => ({
    item: e,
    key: `${e.id}::${e.target}`,
    // Propagated entries (effect-propagation.md §5.1) omit `line`. An infinite fuzz admits
    // every same-key candidate, so no placeholder can put an effect outside the window — but
    // §5.2.0 ranks the admitted candidates by distance, so `0` does read as "at the top of
    // the Symbol" and a propagated effect prefers the earliest local one carrying its key.
    // Effects are already keyed by `(id, target)`, which is the whole of their identity in
    // ir-schema §7, so a tie only arises between two entries that agree on it; the choice
    // between those is what §5.2.0's exact-content pass settles.
    line: e.line ?? 0,
  })
  return differentiate(base.map(mapper), head.map(mapper), effectsEqual, Number.POSITIVE_INFINITY)
}

function effectsEqual(a: Effect, b: Effect): boolean {
  return (
    a.id === b.id && a.target === b.target && a.plugin === b.plugin && a.confidence === b.confidence
  )
}

function diffCalls(base: readonly Call[], head: readonly Call[], lineFuzz: number): ArrayDelta {
  const mapper = (c: Call): Identified<Call> => ({
    item: c,
    key: c.target,
    line: c.line,
  })
  return differentiate(base.map(mapper), head.map(mapper), callsEqual, lineFuzz)
}

function callsEqual(a: Call, b: Call): boolean {
  return a.target === b.target && (a.resolved ?? null) === (b.resolved ?? null)
}

/**
 * §5.2.2 — decorator diff. Identity is `name`; when the same-named decorator is present
 * on both sides within the line-fuzz window, the argument list determines whether the
 * entry is a modified pair or an implicit no-op.
 */
function diffDecorators(
  base: readonly Decorator[],
  head: readonly Decorator[],
  lineFuzz: number,
): ArrayDelta {
  const mapper = (d: Decorator): Identified<Decorator> => ({
    item: d,
    key: d.name,
    line: d.line,
  })
  return differentiate(base.map(mapper), head.map(mapper), decoratorsEqual, lineFuzz)
}

function decoratorsEqual(a: Decorator, b: Decorator): boolean {
  if (a.name !== b.name) return false
  if (a.arguments.length !== b.arguments.length) return false
  for (let i = 0; i < a.arguments.length; i++) {
    if (a.arguments[i] !== b.arguments[i]) return false
  }
  return true
}

/**
 * §5.3 — signature delta. Three cases:
 * - both sides `null` → `null` (nothing to compare)
 * - exactly one side `null` → the present side is emitted verbatim as
 *   `added` (when only head has a signature) or `removed` (when only base has one);
 *   the three axis booleans compare the missing side against `false` defaults
 * - both sides non-null → per-list sub-deltas:
 *   - `inputs`: strict positional compare via `differentiate(..., lineFuzz: 0)` — index
 *     used as the line key so ordered parameter lists match position-for-position
 *   - `outputs`: positional compare (added/removed emitted when the arrays diverge at
 *     an index), no `modified` category
 *   - `throws`: unordered set diff — duplicates collapse per Set semantics
 *   - `async` / `generator` / `typeParameters` change flags follow the raw fields
 */
function diffSignature(base: Signature | null, head: Signature | null): SignatureDelta | null {
  if (base === null && head === null) return null
  if (base === null || head === null) {
    const empty: ArrayDelta = { added: [], removed: [], modified: [] }
    const present = base ?? head
    if (present === null) return null
    const isBaseNull = base === null
    const inputs: ArrayDelta = isBaseNull
      ? { added: [...present.inputs], removed: [], modified: [] }
      : { added: [], removed: [...present.inputs], modified: [] }
    const outputs: ArrayDelta = isBaseNull
      ? { added: [...present.outputs], removed: [], modified: [] }
      : { added: [], removed: [...present.outputs], modified: [] }
    const throws: ArrayDelta = isBaseNull
      ? { added: [...present.throws], removed: [], modified: [] }
      : { added: [], removed: [...present.throws], modified: [] }
    return {
      inputs,
      outputs,
      throws,
      asyncChanged: (base?.async ?? false) !== (head?.async ?? false),
      generatorChanged: (base?.generator ?? false) !== (head?.generator ?? false),
      typeParametersChanged: !arraysEqual(
        base?.typeParameters ?? empty.added.map(String),
        head?.typeParameters ?? empty.added.map(String),
      ),
    }
  }
  /**
   * Parameters are positional, so the index is part of the identity and the fuzz below is 0.
   * That makes each key unique within its list, so §5.2.0 never has a choice to make here and
   * both of its passes reduce to the same positional comparison. Dropping the index from the
   * key would make two same-named parameters ambiguous and hand the choice back to §5.2.0,
   * which is not what a positional list wants.
   */
  const inputMapper = (
    input: { name: string; type: string },
    index: number,
  ): Identified<{ name: string; type: string }> => ({
    item: input,
    key: `${index}:${input.name}`,
    line: index,
  })
  const inputs = differentiate(
    base.inputs.map(inputMapper),
    head.inputs.map(inputMapper),
    (a, b) => a.name === b.name && a.type === b.type,
    0,
  )
  const outputs = diffStringList(base.outputs, head.outputs)
  const throws = diffStringSet(base.throws, head.throws)
  return {
    inputs,
    outputs,
    throws,
    asyncChanged: base.async !== head.async,
    generatorChanged: base.generator !== head.generator,
    typeParametersChanged: !arraysEqual(base.typeParameters, head.typeParameters),
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

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
