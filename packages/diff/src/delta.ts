import { compareCodeUnit, stringArraysEqual } from "@aburi/core"
import type {
  ArrayDelta,
  Call,
  Decorator,
  Effect,
  Symbol as IRSymbol,
  MiddlewareDelta,
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
   * How many lines apart, each counted from its own Symbol's first line, an edited rule, call or
   * decorator may sit from its predecessor and still pair with it: an integer from
   * `MIN_LINE_FUZZ` to `MAX_LINE_FUZZ`, `DEFAULT_LINE_FUZZ` when left out.
   */
  lineFuzz?: number
}

export function computeSymbolDelta(
  base: IRSymbol,
  head: IRSymbol,
  options: DeltaOptions = {},
): SymbolDelta {
  const fuzz = validateLineFuzz(options.lineFuzz ?? DEFAULT_LINE_FUZZ)
  const origins: Origins = [base.source.startLine, head.source.startLine]
  const middleware =
    base.middleware === undefined && head.middleware === undefined
      ? {}
      : { middleware: diffMiddleware(base.middleware ?? [], head.middleware ?? []) }
  return {
    apiChanged: base.fingerprint.api !== head.fingerprint.api,
    logicChanged: base.fingerprint.logic !== head.fingerprint.logic,
    syntaxChanged: base.fingerprint.syntax !== head.fingerprint.syntax,
    componentChanged: (base.component ?? null) !== (head.component ?? null),
    visibilityChanged: base.visibility !== head.visibility,
    confidenceChanged: base.confidence !== head.confidence,
    rules: diffRules(base.rules, head.rules, origins, fuzz),
    effects: diffEffects(base.effects, head.effects, origins),
    calls: diffCalls(base.calls, head.calls, origins, fuzz),
    decorators: diffDecorators(base.decorators, head.decorators, origins, fuzz),
    signature: diffSignature(base.signature ?? null, head.signature ?? null),
    ...middleware,
  }
}

function validateLineFuzz(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new DiffError(
      `lineFuzz must be an integer in [${MIN_LINE_FUZZ}, ${MAX_LINE_FUZZ}]; got ${String(value)}.`,
      { code: "invalid-line-fuzz", value: String(value) },
    )
  }
  if (value < MIN_LINE_FUZZ || value > MAX_LINE_FUZZ) {
    throw new DiffError(
      `lineFuzz must be within [${MIN_LINE_FUZZ}, ${MAX_LINE_FUZZ}]; got ${value}.`,
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
 * The first line of the base and of the head Symbol. An element's line is counted from its own
 * Symbol's, so an edit in a body that lines were inserted above still sits beside its predecessor.
 */
type Origins = readonly [base: number, head: number]

function identifyEach<T>(
  base: readonly T[],
  head: readonly T[],
  origins: Origins,
  identify: (element: T, origin: number) => Identified<T>,
): [Identified<T>[], Identified<T>[]] {
  return [
    base.map((element) => identify(element, origins[0])),
    head.map((element) => identify(element, origins[1])),
  ]
}

function classifyArrayDelta<T>(
  base: readonly Identified<T>[],
  head: readonly Identified<T>[],
  isEqual: (a: T, b: T) => boolean,
  lineFuzz: number,
): ArrayDelta {
  const freeBase = new Set(base.map((_, index) => index))
  const freeHead = new Set(head.map((_, index) => index))
  const partnerOf = new Map<number, Identified<T>>()
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

interface AssignmentScore {
  pairs: number
  distance: number
}

const EMPTY_ASSIGNMENT: AssignmentScore = { pairs: 0, distance: 0 }

function outranks(a: AssignmentScore, b: AssignmentScore): boolean {
  return a.pairs !== b.pairs ? a.pairs > b.pairs : a.distance < b.distance
}

function sameScore(a: AssignmentScore, b: AssignmentScore): boolean {
  return a.pairs === b.pairs && a.distance === b.distance
}

function assignInOrder<T>(
  base: readonly Slot<T>[],
  head: readonly Slot<T>[],
  admits: (b: Identified<T>, h: Identified<T>) => boolean,
): Array<[Slot<T>, Slot<T>]> {
  const bestFromSuffix: AssignmentScore[][] = Array.from({ length: base.length + 1 }, () =>
    Array.from({ length: head.length + 1 }, () => EMPTY_ASSIGNMENT),
  )
  const bestFrom = (i: number, j: number): AssignmentScore =>
    bestFromSuffix[i]?.[j] ?? EMPTY_ASSIGNMENT
  const pairingAt = (
    i: number,
    j: number,
  ): { score: AssignmentScore; pair: [Slot<T>, Slot<T>] } | null => {
    const b = base[i]
    const h = head[j]
    if (b === undefined || h === undefined || !admits(b.element, h.element)) return null
    const rest = bestFrom(i + 1, j + 1)
    const distance = rest.distance + Math.abs(b.element.line - h.element.line)
    return { score: { pairs: rest.pairs + 1, distance }, pair: [b, h] }
  }
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = head.length - 1; j >= 0; j--) {
      const skipBase = bestFrom(i + 1, j)
      const skipHead = bestFrom(i, j + 1)
      let winner = outranks(skipBase, skipHead) ? skipBase : skipHead
      const paired = pairingAt(i, j)?.score
      if (paired !== undefined && outranks(paired, winner)) winner = paired
      const row = bestFromSuffix[i]
      if (row !== undefined) row[j] = winner
    }
  }

  const chosen: Array<[Slot<T>, Slot<T>]> = []
  let i = 0
  let j = 0
  while (i < base.length && j < head.length) {
    const optimum = bestFrom(i, j)
    const paired = pairingAt(i, j)
    if (paired !== null && sameScore(paired.score, optimum)) {
      chosen.push(paired.pair)
      i++
      j++
    } else if (sameScore(bestFrom(i + 1, j), optimum)) {
      i++
    } else {
      j++
    }
  }
  return chosen
}

function diffRules(
  base: readonly Rule[],
  head: readonly Rule[],
  origins: Origins,
  lineFuzz: number,
): ArrayDelta {
  const [b, h] = identifyEach(base, head, origins, (rule, origin) => ({
    item: rule,
    key: rule.type,
    line: rule.line - origin,
  }))
  return classifyArrayDelta(b, h, rulesEqual, lineFuzz)
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

function diffEffects(
  base: readonly Effect[],
  head: readonly Effect[],
  origins: Origins,
): ArrayDelta {
  const [b, h] = identifyEach(base, head, origins, (effect, origin) => ({
    item: effect,
    key: `${effect.id}::${effect.target}`,
    line: effect.line === undefined ? 0 : effect.line - origin,
  }))
  return classifyArrayDelta(b, h, effectsEqual, Number.POSITIVE_INFINITY)
}

function effectsEqual(a: Effect, b: Effect): boolean {
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

function diffCalls(
  base: readonly Call[],
  head: readonly Call[],
  origins: Origins,
  lineFuzz: number,
): ArrayDelta {
  const [b, h] = identifyEach(base, head, origins, (call, origin) => ({
    item: call,
    key: call.target,
    line: call.line - origin,
  }))
  return classifyArrayDelta(b, h, callsEqual, lineFuzz)
}

function callsEqual(a: Call, b: Call): boolean {
  return a.target === b.target && (a.resolved ?? null) === (b.resolved ?? null)
}

function diffDecorators(
  base: readonly Decorator[],
  head: readonly Decorator[],
  origins: Origins,
  lineFuzz: number,
): ArrayDelta {
  const [b, h] = identifyEach(base, head, origins, (decorator, origin) => ({
    item: decorator,
    key: decorator.name,
    line: decorator.line - origin,
  }))
  return classifyArrayDelta(b, h, decoratorsEqual, lineFuzz)
}

function decoratorsEqual(a: Decorator, b: Decorator): boolean {
  return (
    a.name === b.name &&
    (a.qualifier ?? null) === (b.qualifier ?? null) &&
    stringArraysEqual(a.arguments, b.arguments)
  )
}

type SignatureInput = Signature["inputs"][number]

function inputsEqual(a: SignatureInput, b: SignatureInput): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    (a.optional === true) === (b.optional === true) &&
    (a.rest === true) === (b.rest === true)
  )
}

function diffSignature(base: Signature | null, head: Signature | null): SignatureDelta | null {
  if (base === null) return head === null ? null : oneSidedSignatureDelta(head, "added")
  if (head === null) return oneSidedSignatureDelta(base, "removed")
  const inputMapper = (input: SignatureInput, index: number): Identified<SignatureInput> => ({
    item: input,
    key: `${index}:${input.name}`,
    line: index,
  })
  const inputs = classifyArrayDelta(
    base.inputs.map(inputMapper),
    head.inputs.map(inputMapper),
    inputsEqual,
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

function diffMiddleware(base: readonly string[], head: readonly string[]): MiddlewareDelta {
  const added = beyondCounts(head, base)
  const removed = beyondCounts(base, head)
  const shared = base.length - removed.length
  return { added, removed, reordered: longestCommonSubsequence(base, head) < shared }
}

/** The occurrences in `side` that `other` holds no counterpart for, the earlier ones paired first. */
function beyondCounts(side: readonly string[], other: readonly string[]): string[] {
  const budget = new Map<string, number>()
  for (const name of other) budget.set(name, (budget.get(name) ?? 0) + 1)
  const extra: string[] = []
  for (const name of side) {
    const left = budget.get(name) ?? 0
    if (left > 0) budget.set(name, left - 1)
    else extra.push(name)
  }
  return extra
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0)
  for (const x of a) {
    const current = [0]
    for (const [j, y] of b.entries()) {
      current.push(
        x === y ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, current[j] ?? 0),
      )
    }
    previous = current
  }
  return previous[b.length] ?? 0
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
