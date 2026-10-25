import type {
  ArrayDelta,
  ComponentId,
  Confidence,
  Signature,
  SignatureDelta,
  SymbolDelta,
} from "@aburi/types"
import {
  callRowText,
  compareStrings,
  confidenceBadge,
  effectOrigin,
  effectRowText,
  formatInput,
  inlineCode,
  joinCode,
  lastSegment,
  ruleRowText,
  typeParametersText,
} from "../format"
import type { ChangedEntry } from "./partition"

export function renderDeltaBody(change: ChangedEntry): string[] {
  const { delta, before, after } = change
  const rows: string[] = []
  if (before.name !== after.name) {
    rows.push(`- name: ${inlineCode(before.name)} → ${inlineCode(after.name)}`)
  }
  // Only the last segment reaches the API fingerprint, so the name row counts as an explanation
  // only when that segment changed.
  const shortNameChanged = lastSegment(before.name) !== lastSegment(after.name)
  const nameRows = rows.length
  appendSignatureDelta(rows, delta.signature ?? null, [before.signature, after.signature])
  appendDecoratorDelta(rows, delta.decorators, [before.decorators, after.decorators])
  appendInlineRow(rows, "export name added", delta.exportedAs?.added ?? [])
  appendInlineRow(rows, "export name removed", delta.exportedAs?.removed ?? [])
  appendArrayGroup(rows, "rules", delta.rules, RULES, [before.rules, after.rules])
  appendArrayGroup(rows, "effects", delta.effects, EFFECTS, [before.effects, after.effects])
  appendArrayGroup(rows, "calls", delta.calls, CALLS, [before.calls, after.calls])
  const explained = rows.length > nameRows || shortNameChanged || delta.visibilityChanged
  if (delta.componentChanged) {
    rows.push(`- component: ${componentText(before.component)} → ${componentText(after.component)}`)
  }
  if (delta.visibilityChanged) {
    rows.push(`- visibility: ${inlineCode(before.visibility)} → ${inlineCode(after.visibility)}`)
  }
  if (delta.confidenceChanged === true) {
    rows.push(
      `- confidence: ${inlineCode(change.before.confidence)} → ${inlineCode(change.after.confidence)}`,
    )
  }
  if (!explained) appendUnexplainedChangeNote(delta, rows)
  return rows
}

function appendUnexplainedChangeNote(delta: SymbolDelta, rows: string[]): void {
  const which = delta.apiChanged
    ? "API"
    : delta.logicChanged
      ? "logic"
      : delta.syntaxChanged
        ? "syntax"
        : null
  if (which === null) return
  rows.push(`- ${which} fingerprint changed; no field-level detail was recorded`)
}

// An absent key reads as null, as a Symbol outside every declared Component.
function componentText(component: ComponentId | null | undefined): string {
  return component === undefined || component === null ? "none" : inlineCode(component)
}

type SignatureSides = readonly [
  before: Signature | null | undefined,
  after: Signature | null | undefined,
]

function appendSignatureDelta(
  rows: string[],
  sig: SignatureDelta | null,
  [before, after]: SignatureSides,
): void {
  if (sig === null) return
  const inputSides: Sides = [before?.inputs ?? [], after?.inputs ?? []]
  if (sig.outputs.added.length > 0 || sig.outputs.removed.length > 0) {
    const removed = renderStringList(sig.outputs.removed)
    const added = renderStringList(sig.outputs.added)
    rows.push(`- signature.outputs: ${inlineCode(removed)} → ${inlineCode(added)}`)
  }
  appendInlineRow(rows, "signature.outputs modified", sig.outputs.modified)
  appendInlineRow(rows, "signature.throws added", sig.throws.added)
  appendInlineRow(rows, "signature.throws removed", sig.throws.removed)
  appendInlineRow(rows, "signature.throws modified", sig.throws.modified)
  const inputs = bucketRows(sig.inputs, INPUTS, inputSides)
  for (const bucket of BUCKETS) {
    const count = sig.inputs[bucket].length
    if (count === 0) continue
    const rendered = inputs[bucket].length > 0 ? inputs[bucket].join(", ") : `${count} item(s)`
    rows.push(`- signature.inputs ${bucket}: ${rendered}`)
  }
  if (sig.asyncChanged) {
    rows.push(`- signature.async: ${flagOrNone(before, "async")} → ${flagOrNone(after, "async")}`)
  }
  if (sig.generatorChanged) {
    rows.push(
      `- signature.generator: ${flagOrNone(before, "generator")} → ${flagOrNone(after, "generator")}`,
    )
  }
  if (sig.typeParametersChanged) {
    rows.push(
      `- signature.typeParameters: ${typeParametersOrNone(before)} → ${typeParametersOrNone(after)}`,
    )
  }
}

/** A side with no signature never said whether it was async; `false` would claim it did. */
function flagOrNone(signature: Signature | null | undefined, flag: "async" | "generator"): string {
  return signature === null || signature === undefined ? "none" : String(signature[flag])
}

function typeParametersOrNone(signature: Signature | null | undefined): string {
  const typeParameters = signature?.typeParameters ?? []
  return typeParameters.length === 0 ? "none" : inlineCode(typeParametersText(typeParameters))
}

function appendDecoratorDelta(rows: string[], delta: ArrayDelta | undefined, sides: Sides): void {
  if (delta === undefined) return
  const lines = bucketRows(delta, DECORATORS, sides)
  for (const bucket of BUCKETS) {
    for (const line of lines[bucket]) rows.push(`- decorator ${bucket}: ${line}`)
  }
}

function qualifiedName(d: DecoratorLike): string {
  return d.qualifier === undefined ? d.name : `${d.qualifier}.${d.name}`
}

function appendArrayGroup<T>(
  rows: string[],
  label: string,
  delta: ArrayDelta | undefined,
  elements: DeltaElements<T>,
  sides: Sides,
): void {
  if (delta === undefined) return
  const lines = bucketRows(delta, elements, sides)
  for (const bucket of BUCKETS) {
    if (lines[bucket].length === 0) continue
    rows.push(`- ${label} ${bucket}:`)
    for (const line of lines[bucket]) rows.push(`  - ${line}`)
  }
}

const BUCKETS = ["added", "removed", "modified"] as const

/** One array as the base and the head Symbol hold it. */
type Sides = readonly [before: readonly unknown[], after: readonly unknown[]]

/** One field a delta row shows. */
interface Part<T> {
  text(item: T): string
  /**
   * Whether two elements agree on the fields the diff compares behind this part, which need not be
   * what it prints; by default, whether they read alike.
   */
  same?(a: T, b: T): boolean
  /** This part of a modified row whose base element was `was`; by default `was → now`. */
  changed?(was: T, now: T): string
}

/** How one delta array's elements read, and what the diff pairs and compares them on. */
interface DeltaElements<T> {
  read(value: unknown): T | null
  /** The diff's key, or a coarser one, which only adds candidates for the base element. */
  key(item: T): string
  /** Under one key, two elements agree on every part exactly when the diff calls them equal. */
  parts: readonly Part<T>[]
  row(item: T, show: (part: Part<T>) => string): string
  /** A modified element's row, where it is not `row`. */
  modifiedRow?(item: T, show: (part: Part<T>) => string): string
}

function bucketRows<T>(
  delta: ArrayDelta,
  elements: DeltaElements<T>,
  sides: Sides,
): Record<(typeof BUCKETS)[number], string[]> {
  const plain = (item: T) => elements.row(item, (part) => part.text(item))
  const modifiedRow = elements.modifiedRow ?? elements.row
  const bases = delta.modified.length === 0 ? [] : modifiedBases(delta, elements, sides)
  const modified = (item: T) => {
    const candidates = bases.filter(
      (b) => elements.key(b) === elements.key(item) && !alike(elements, b, item),
    )
    return modifiedRow(item, (part) => modifiedPart(part, item, candidates))
  }
  return {
    added: readAll(delta.added, elements).map(plain),
    removed: readAll(delta.removed, elements).map(plain),
    modified: readAll(delta.modified, elements).map(modified),
  }
}

/**
 * The base elements the diff may have paired with a modified element. It leaves every base element
 * removed, paired with a head element it equals, or paired with a modified one, so each unchanged
 * head element accounts for one base element equal to it. An element stays whenever one equal to it
 * is left, as the delta does not say which of two equal elements on different lines was taken.
 */
function modifiedBases<T>(delta: ArrayDelta, elements: DeltaElements<T>, sides: Sides): T[] {
  const [before, after] = sides
  const kept = readEvery(withoutEach(before, delta.removed), elements)
  // An element that cannot be read could be any modified element's base.
  if (kept === null) return []
  const unchanged = readAll(withoutEach(after, [...delta.added, ...delta.modified]), elements)
  const left = [...kept]
  for (const item of unchanged) {
    const at = left.findIndex((b) => alike(elements, b, item))
    if (at >= 0) left.splice(at, 1)
  }
  return kept.filter((b) => left.some((l) => alike(elements, l, b)))
}

function readAll<T>(values: readonly unknown[], elements: DeltaElements<T>): T[] {
  return values.flatMap((value) => {
    const item = elements.read(value)
    return item === null ? [] : [item]
  })
}

function readEvery<T>(values: readonly unknown[], elements: DeltaElements<T>): T[] | null {
  const items = readAll(values, elements)
  return items.length === values.length ? items : null
}

/** `values` less one element equal to each of `taken`; a delta bucket holds elements as they are. */
function withoutEach(values: readonly unknown[], taken: readonly unknown[]): unknown[] {
  const left = [...values]
  for (const value of taken) {
    const at = left.findIndex((v) => sameValue(v, value))
    if (at >= 0) left.splice(at, 1)
  }
  return left
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    )
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keys = definedKeys(a)
  return keys.length === definedKeys(b).length && keys.every((key) => sameValue(a[key], b[key]))
}

// A key holding `undefined` is one JSON drops.
function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined)
}

function alike<T>(elements: DeltaElements<T>, a: T, b: T): boolean {
  return elements.key(a) === elements.key(b) && elements.parts.every((part) => agree(part, a, b))
}

function agree<T>(part: Part<T>, a: T, b: T): boolean {
  return part.same?.(a, b) ?? part.text(a) === part.text(b)
}

/**
 * The diff paired `now` with one of `candidates`, so where every one of them differs from `now`
 * on this part and all of them read alike, that reading is the base value.
 */
function modifiedPart<T>(part: Part<T>, now: T, candidates: readonly T[]): string {
  const [was, ...others] = candidates
  if (
    was === undefined ||
    candidates.some((c) => agree(part, c, now)) ||
    others.some((c) => part.text(c) !== part.text(was)) ||
    part.text(was) === part.text(now)
  ) {
    return part.text(now)
  }
  return part.changed?.(was, now) ?? `${part.text(was)} → ${part.text(now)}`
}

/** A part the element lacks, shown only where the row sets a base value beside it. */
function optionalPart<T>(
  absent: boolean,
  part: Part<T>,
  item: T,
  show: (part: Part<T>) => string,
): string | null {
  const shown = show(part)
  return absent && shown === part.text(item) ? null : shown
}

interface DecoratorLike {
  name: string
  qualifier: string | undefined
  raw: string | undefined
  arguments: readonly string[]
}

const decoratorText: Part<DecoratorLike> = {
  text: (d) => inlineCode(`@${d.raw ?? qualifiedName(d)}`),
  same: (a, b) => a.qualifier === b.qualifier && sameStrings(a.arguments, b.arguments),
}

const DECORATORS: DeltaElements<DecoratorLike> = {
  read: asDecoratorLike,
  key: (d) => d.name,
  parts: [decoratorText],
  row: (_, show) => show(decoratorText),
}

interface RuleLike {
  type: string
  line: number
  condition: string | undefined
  what: string | undefined
  expr: string | undefined
  loopKind: string | undefined
}

const rulePayload: Part<RuleLike> = {
  text: (r) => codeOrNone(payloadOf(r)),
  same: (a, b) => a.condition === b.condition && a.what === b.what && a.expr === b.expr,
}

const ruleLoopKind: Part<RuleLike> = { text: (r) => codeOrNone(r.loopKind) }

const RULES: DeltaElements<RuleLike> = {
  read: asRuleLike,
  key: (r) => r.type,
  parts: [rulePayload, ruleLoopKind],
  row: (r, show) =>
    ruleRowText({
      type: r.type,
      payload: optionalPart(payloadOf(r) === undefined, rulePayload, r, show),
      loopKind: optionalPart(r.loopKind === undefined, ruleLoopKind, r, show),
      line: r.line,
    }),
}

function payloadOf(rule: RuleLike): string | undefined {
  return rule.condition ?? rule.what ?? rule.expr
}

function codeOrNone(value: string | undefined): string {
  return value === undefined ? "none" : inlineCode(value)
}

interface EffectLike {
  id: string
  target: string
  line: number | undefined
  propagated: boolean | undefined
  derivedFrom: readonly string[] | undefined
  plugin: string | undefined
  confidence: Confidence | undefined
}

const effectFrom: Part<EffectLike> = {
  text: effectOrigin,
  same: (a, b) =>
    (a.propagated ?? false) === (b.propagated ?? false) &&
    sameStrings(sortedSources(a), sortedSources(b)),
}

const effectPlugin: Part<EffectLike> = {
  text: (e) => e.plugin ?? "none",
  same: (a, b) => a.plugin === b.plugin,
}

const effectConfidence: Part<EffectLike> = {
  text: badgeOf,
  same: (a, b) => a.confidence === b.confidence,
  // `high` has no badge to show, so the base side spells it.
  changed: (was, now) =>
    was.confidence === undefined
      ? badgeOf(now)
      : `${badgeOf(now)} (was ${badgeOf(was).trim() || "high"})`,
}

const EFFECTS: DeltaElements<EffectLike> = {
  read: asEffectLike,
  key: (e) => `${e.id}::${e.target}`,
  parts: [effectFrom, effectPlugin, effectConfidence],
  row: (e, show) =>
    effectRowText({
      id: e.id,
      target: inlineCode(e.target),
      origin: show(effectFrom),
      plugin: optionalPart(e.plugin === undefined, effectPlugin, e, show),
      badge: show(effectConfidence),
    }),
}

function sortedSources(effect: EffectLike): string[] {
  return [...(effect.derivedFrom ?? [])].sort(compareStrings)
}

function badgeOf(effect: EffectLike): string {
  return effect.confidence === undefined ? "" : confidenceBadge(effect.confidence)
}

interface CallLike {
  target: string
  line: number
  resolved: string | null
}

const callResolved: Part<CallLike> = {
  text: (c) => (c.resolved === null ? "none" : inlineCode(c.resolved)),
}

const CALLS: DeltaElements<CallLike> = {
  read: asCallLike,
  key: (c) => c.target,
  parts: [callResolved],
  row: (c) => callRowText(c),
  // What a call resolves to is all a modified one can differ in, so only its row names it.
  modifiedRow: (c, show) => `${callRowText(c)} resolved: ${show(callResolved)}`,
}

interface InputLike {
  name: string
  written: string
}

const inputText: Part<InputLike> = { text: (i) => inlineCode(i.written) }

const INPUTS: DeltaElements<InputLike> = {
  read: asInputLike,
  key: (i) => i.name,
  parts: [inputText],
  row: (_, show) => show(inputText),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item): item is string => typeof item === "string") ? value : undefined
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function isConfidence(value: unknown): value is Confidence {
  return value === "high" || value === "medium" || value === "low"
}

function asDecoratorLike(value: unknown): DecoratorLike | null {
  if (!isRecord(value)) return null
  const { name, qualifier, raw } = value
  if (typeof name !== "string") return null
  return {
    name,
    // Empty is as malformed as absent, and would print `@.Post`.
    qualifier: typeof qualifier === "string" && qualifier !== "" ? qualifier : undefined,
    raw: typeof raw === "string" ? raw : undefined,
    arguments: stringsOf(value.arguments) ?? [],
  }
}

function asRuleLike(value: unknown): RuleLike | null {
  if (!isRecord(value)) return null
  const type = value.type
  const line = value.line
  if (typeof type !== "string" || typeof line !== "number") return null
  const readOptional = (key: "condition" | "what" | "expr" | "loopKind"): string | undefined => {
    const v = value[key]
    return typeof v === "string" ? v : undefined
  }
  return {
    type,
    line,
    condition: readOptional("condition"),
    what: readOptional("what"),
    expr: readOptional("expr"),
    loopKind: readOptional("loopKind"),
  }
}

function asEffectLike(value: unknown): EffectLike | null {
  if (!isRecord(value)) return null
  const { id, target, line, propagated, derivedFrom, plugin, confidence } = value
  if (typeof id !== "string" || typeof target !== "string") return null
  if (line !== undefined && typeof line !== "number") return null
  if (propagated !== undefined && typeof propagated !== "boolean") return null
  if (derivedFrom !== undefined && stringsOf(derivedFrom) === undefined) return null
  if (propagated !== true && line === undefined) return null
  if (propagated === true && (stringsOf(derivedFrom) ?? []).length === 0) return null
  return {
    id,
    target,
    line,
    propagated,
    derivedFrom: stringsOf(derivedFrom),
    plugin: typeof plugin === "string" ? plugin : undefined,
    confidence: isConfidence(confidence) ? confidence : undefined,
  }
}

function asCallLike(value: unknown): CallLike | null {
  if (!isRecord(value)) return null
  const { target, line, resolved } = value
  if (typeof target !== "string" || typeof line !== "number") return null
  return { target, line, resolved: typeof resolved === "string" ? resolved : null }
}

function asInputLike(value: unknown): InputLike | null {
  if (!isRecord(value)) return null
  const { name, type, optional, rest } = value
  if (typeof name !== "string" || typeof type !== "string") return null
  return {
    name,
    written: formatInput({ name, type, optional: optional === true, rest: rest === true }),
  }
}

function renderStringList(values: readonly unknown[]): string {
  const strings = values.filter((v): v is string => typeof v === "string")
  return strings.length === 0 ? "—" : strings.join(" | ")
}

function appendInlineRow(rows: string[], label: string, values: readonly unknown[]): void {
  const rendered = joinCode(values.filter((v): v is string => typeof v === "string"))
  if (rendered === "") return
  rows.push(`- ${label}: ${rendered}`)
}
