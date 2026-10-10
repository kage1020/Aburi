import type { ArrayDelta, SignatureDelta, SymbolDelta } from "@aburi/types"
import { formatInput, inlineCode, propagatedFromSuffix } from "../format"
import type { ChangedEntry } from "./partition"

export function renderDeltaBody(change: ChangedEntry): string[] {
  const { delta } = change
  const rows: string[] = []
  appendSignatureDelta(rows, delta.signature ?? null)
  appendDecoratorDelta(rows, delta.decorators)
  appendArrayGroup(rows, "rules", delta.rules, describeRuleLike)
  appendArrayGroup(rows, "effects", delta.effects, describeEffectLike)
  appendArrayGroup(rows, "calls", delta.calls, describeCallLike)
  const explained = rows.length > 0 || delta.visibilityChanged
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

function appendSignatureDelta(rows: string[], sig: SignatureDelta | null): void {
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
  if (sig.inputs.added.length > 0) {
    rows.push(`- signature.inputs added: ${describeInputs(sig.inputs.added)}`)
  }
  if (sig.inputs.removed.length > 0) {
    rows.push(`- signature.inputs removed: ${describeInputs(sig.inputs.removed)}`)
  }
  if (sig.inputs.modified.length > 0) {
    rows.push(`- signature.inputs modified: ${describeInputs(sig.inputs.modified)}`)
  }
  if (sig.asyncChanged) rows.push(`- signature.async: toggled`)
  if (sig.generatorChanged) rows.push(`- signature.generator: toggled`)
  if (sig.typeParametersChanged) rows.push(`- signature.typeParameters: changed`)
}

function appendDecoratorDelta(rows: string[], delta: ArrayDelta | undefined): void {
  if (delta === undefined) return
  const buckets: [string, readonly unknown[], (d: DecoratorLike) => string][] = [
    ["added", delta.added, (d) => d.raw ?? qualifiedName(d)],
    ["removed", delta.removed, (d) => d.raw ?? qualifiedName(d)],
    ["modified", delta.modified, qualifiedName],
  ]
  for (const [label, items, show] of buckets) {
    for (const item of items) {
      const decorator = asDecoratorLike(item)
      if (decorator === null) continue
      rows.push(`- decorator ${label}: ${inlineCode(`@${show(decorator)}`)}`)
    }
  }
}

function qualifiedName(d: DecoratorLike): string {
  return d.qualifier === undefined ? d.name : `${d.qualifier}.${d.name}`
}

function appendArrayGroup(
  rows: string[],
  label: string,
  delta: ArrayDelta | undefined,
  describe: (item: unknown) => string | null,
): void {
  if (delta === undefined) return
  appendBucket(rows, `${label} added`, delta.added, describe)
  appendBucket(rows, `${label} removed`, delta.removed, describe)
  appendBucket(rows, `${label} modified`, delta.modified, describe)
}

function appendBucket(
  rows: string[],
  label: string,
  items: readonly unknown[],
  describe: (item: unknown) => string | null,
): void {
  if (items.length === 0) return
  const lines = items.map(describe).filter((line): line is string => line !== null)
  if (lines.length === 0) return
  rows.push(`- ${label}:`)
  for (const line of lines) rows.push(`  - ${line}`)
}

interface DecoratorLike {
  name: string
  qualifier?: string | undefined
  raw?: string | undefined
}
interface RuleLike {
  type: string
  line: number
  condition?: string | undefined
  what?: string | undefined
  expr?: string | undefined
}
interface EffectLike {
  id: string
  target: string
  line?: number | undefined
  propagated?: boolean | undefined
  derivedFrom?: readonly string[] | undefined
}
interface CallLike {
  target: string
  line: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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
  }
}

function asRuleLike(value: unknown): RuleLike | null {
  if (!isRecord(value)) return null
  const type = value.type
  const line = value.line
  if (typeof type !== "string" || typeof line !== "number") return null
  const readOptional = (key: "condition" | "what" | "expr"): string | undefined => {
    const v = value[key]
    return typeof v === "string" ? v : undefined
  }
  return {
    type,
    line,
    condition: readOptional("condition"),
    what: readOptional("what"),
    expr: readOptional("expr"),
  }
}

function asEffectLike(value: unknown): EffectLike | null {
  if (!isRecord(value)) return null
  const { id, target, line, propagated, derivedFrom } = value
  if (typeof id !== "string" || typeof target !== "string") return null
  if (line !== undefined && typeof line !== "number") return null
  if (propagated !== undefined && typeof propagated !== "boolean") return null
  if (
    derivedFrom !== undefined &&
    (!Array.isArray(derivedFrom) ||
      !derivedFrom.every((source): source is string => typeof source === "string"))
  ) {
    return null
  }
  return {
    id,
    target,
    line,
    propagated,
    derivedFrom,
  }
}

function asCallLike(value: unknown): CallLike | null {
  if (!isRecord(value)) return null
  const { target, line } = value
  if (typeof target !== "string" || typeof line !== "number") return null
  return { target, line }
}

function describeRuleLike(value: unknown): string | null {
  const rule = asRuleLike(value)
  if (rule === null) return null
  const detail = rule.condition ?? rule.what ?? rule.expr
  const detailPart = detail === undefined ? "" : `: ${inlineCode(detail)}`
  return `${rule.type}${detailPart} (L${rule.line})`
}

function describeEffectLike(value: unknown): string | null {
  const eff = asEffectLike(value)
  if (eff === null) return null
  if (eff.propagated === true) {
    return `${eff.id}: ${inlineCode(eff.target)} ${propagatedFromSuffix(eff.derivedFrom ?? [])}`
  }
  if (eff.line === undefined) return null
  return `${eff.id}: ${inlineCode(eff.target)} (L${eff.line})`
}

function describeCallLike(value: unknown): string | null {
  const call = asCallLike(value)
  if (call === null) return null
  return `${inlineCode(call.target)} (L${call.line})`
}

function describeInputs(items: readonly unknown[]): string {
  const rendered = items
    .map((value) => {
      if (!isRecord(value)) return null
      const { name, type, optional, rest } = value
      if (typeof name !== "string" || typeof type !== "string") return null
      return inlineCode(
        formatInput({ name, type, optional: optional === true, rest: rest === true }),
      )
    })
    .filter((line): line is string => line !== null)
  return rendered.length > 0 ? rendered.join(", ") : `${items.length} item(s)`
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
