import type { ArrayDelta, Confidence, SignatureDelta, SymbolDelta } from "@aburi/types"
import {
  callRowText,
  compareStrings,
  confidenceBadge,
  effectOrigin,
  effectRowText,
  formatInput,
  inlineCode,
  ruleRowText,
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
  appendSignatureDelta(rows, delta.signature ?? null, before.signature?.inputs ?? [])
  appendDecoratorDelta(rows, delta.decorators, before.decorators)
  appendArrayGroup(rows, "rules", delta.rules, RULES, before.rules)
  appendArrayGroup(rows, "effects", delta.effects, EFFECTS, before.effects)
  appendArrayGroup(rows, "calls", delta.calls, CALLS, before.calls)
  const explained = rows.length > nameRows || shortNameChanged || delta.visibilityChanged
  if (delta.componentChanged) rows.push(`- component: changed`)
  if (delta.visibilityChanged) rows.push(`- visibility: changed`)
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

function lastSegment(name: string): string {
  const at = name.lastIndexOf("::")
  const tail = at < 0 ? name : name.slice(at + 2)
  return tail.slice(tail.lastIndexOf(".") + 1)
}

function appendSignatureDelta(
  rows: string[],
  sig: SignatureDelta | null,
  beforeInputs: readonly unknown[],
): void {
  if (sig === null) return
  if (sig.outputs.added.length > 0 || sig.outputs.removed.length > 0) {
    const before = renderStringList(sig.outputs.removed)
    const after = renderStringList(sig.outputs.added)
    rows.push(`- signature.outputs: ${inlineCode(before)} → ${inlineCode(after)}`)
  }
  appendInlineRow(rows, "signature.outputs modified", sig.outputs.modified)
  appendInlineRow(rows, "signature.throws added", sig.throws.added)
  appendInlineRow(rows, "signature.throws removed", sig.throws.removed)
  appendInlineRow(rows, "signature.throws modified", sig.throws.modified)
  const inputs = bucketRows(sig.inputs, INPUTS, beforeInputs)
  for (const bucket of BUCKETS) {
    const count = sig.inputs[bucket].length
    if (count === 0) continue
    const rendered = inputs[bucket].length > 0 ? inputs[bucket].join(", ") : `${count} item(s)`
    rows.push(`- signature.inputs ${bucket}: ${rendered}`)
  }
  if (sig.asyncChanged) rows.push(`- signature.async: toggled`)
  if (sig.generatorChanged) rows.push(`- signature.generator: toggled`)
  if (sig.typeParametersChanged) rows.push(`- signature.typeParameters: changed`)
}

function appendDecoratorDelta(
  rows: string[],
  delta: ArrayDelta | undefined,
  before: readonly unknown[],
): void {
  if (delta === undefined) return
  const lines = bucketRows(delta, DECORATORS, before)
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
  before: readonly unknown[],
): void {
  if (delta === undefined) return
  const lines = bucketRows(delta, elements, before)
  for (const bucket of BUCKETS) {
    if (lines[bucket].length === 0) continue
    rows.push(`- ${label} ${bucket}:`)
    for (const line of lines[bucket]) rows.push(`  - ${line}`)
  }
}

const BUCKETS = ["added", "removed", "modified"] as const

/** One field a delta row shows, among those the diff compares. */
interface Part<T> {
  text(item: T): string
  /** Whether two elements agree on the fields this part shows; by default, whether they read alike. */
  same?(a: T, b: T): boolean
  /** This part of a modified row whose base element was `was`; by default `was → now`. */
  changed?(was: T, now: T): string
}

/** How one delta array's elements read, and what the diff pairs and compares them on. */
interface DeltaElements<T> {
  read(value: unknown): T | null
  key(item: T): string
  /** Every field the diff compares beside the key. */
  parts: readonly Part<T>[]
  row(item: T, show: (part: Part<T>) => string, modified: boolean): string
}

function bucketRows<T>(
  delta: ArrayDelta,
  elements: DeltaElements<T>,
  before: readonly unknown[],
): Record<(typeof BUCKETS)[number], string[]> {
  const base = readAll(before, elements)
  const plain = (item: T) => elements.row(item, (part) => part.text(item), false)
  const modified = (item: T) => {
    const counterparts = base.filter(
      (b) =>
        elements.key(b) === elements.key(item) &&
        !elements.parts.every((part) => agree(part, b, item)),
    )
    return elements.row(item, (part) => modifiedPart(part, item, counterparts), true)
  }
  return {
    added: readAll(delta.added, elements).map(plain),
    removed: readAll(delta.removed, elements).map(plain),
    modified: readAll(delta.modified, elements).map(modified),
  }
}

function readAll<T>(values: readonly unknown[], elements: DeltaElements<T>): T[] {
  return values.flatMap((value) => {
    const item = elements.read(value)
    return item === null ? [] : [item]
  })
}

function agree<T>(part: Part<T>, a: T, b: T): boolean {
  return part.same?.(a, b) ?? part.text(a) === part.text(b)
}

/**
 * The diff paired `now` with one of `counterparts`, so where every one of them differs from `now`
 * on this part and all of them read alike, that reading is the base value.
 */
function modifiedPart<T>(part: Part<T>, now: T, counterparts: readonly T[]): string {
  const [was, ...others] = counterparts
  if (
    was === undefined ||
    counterparts.some((c) => agree(part, c, now)) ||
    others.some((c) => part.text(c) !== part.text(was))
  ) {
    return part.text(now)
  }
  return part.changed?.(was, now) ?? `${part.text(was)} → ${part.text(now)}`
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
      payload: payloadOf(r) === undefined ? null : show(rulePayload),
      loopKind: r.loopKind === undefined ? null : show(ruleLoopKind),
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

const effectPlugin: Part<EffectLike> = { text: (e) => e.plugin ?? "none" }

const effectConfidence: Part<EffectLike> = {
  text: badgeOf,
  // `high` has no badge to show, so the base side spells it.
  changed: (was, now) => `${badgeOf(now)} (was ${badgeOf(was).trim() || "high"})`,
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
      plugin: e.plugin === undefined ? null : show(effectPlugin),
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
  // What a call resolves to is all a modified one can differ in, so only its row names it.
  row: (c, show, modified) =>
    modified ? `${callRowText(c)} resolved: ${show(callResolved)}` : callRowText(c),
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
  const rendered = values
    .filter((v): v is string => typeof v === "string")
    .map((s) => inlineCode(s))
    .join(", ")
  if (rendered === "") return
  rows.push(`- ${label}: ${rendered}`)
}
