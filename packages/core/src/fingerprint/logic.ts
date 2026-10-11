import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { compareBy } from "../order"
import { hashCanonicalObject } from "./hash"
import { normalizeFingerprintString } from "./string"

interface LogicInput {
  effects: Array<{ target: string }>
  rules: Array<{
    condition: string | null
    expr: string | null
    loopKind: "for" | "while" | "do" | null
    type: string
    what: string | null
  }>
}

export function logicFingerprint(symbol: IRSymbol): string {
  return hashCanonicalObject(buildLogicInput(symbol))
}

/** The rule fields that classify a rule rather than say anything about the body it is in. */
const SHAPE_ONLY_RULE_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "loopKind",
] satisfies (keyof LogicInput["rules"][number])[])

export function logicNamesNothing(symbol: IRSymbol): boolean {
  const input = buildLogicInput(symbol)
  return (
    input.effects.length === 0 &&
    input.rules.every((rule) =>
      Object.entries(rule).every(
        ([field, value]) => SHAPE_ONLY_RULE_FIELDS.has(field) || value === null,
      ),
    )
  )
}

function buildLogicInput(symbol: IRSymbol): LogicInput {
  return {
    effects: canonicalizeEffects(symbol.effects),
    rules: canonicalizeRules(symbol.rules),
  }
}

function canonicalizeRules(rules: readonly Rule[]): LogicInput["rules"] {
  // Never re-sorted: a guard before a throw is not a throw before a guard.
  return rules.map((r) => ({
    condition: r.condition !== null ? normalizeFingerprintString(r.condition) : null,
    expr: r.expr !== null ? normalizeFingerprintString(r.expr) : null,
    loopKind: r.loopKind ?? null,
    type: r.type,
    what: r.what !== null ? normalizeFingerprintString(r.what) : null,
  }))
}

function canonicalizeEffects(effects: readonly Effect[]): LogicInput["effects"] {
  const local: LogicInput["effects"] = []
  const propagatedTargets = new Set<string>()
  for (const e of effects) {
    const target = normalizeFingerprintString(e.target)
    if (e.propagated === true) propagatedTargets.add(target)
    else local.push({ target })
  }
  const localTargets = new Set(local.map((e) => e.target))
  const propagated = [...propagatedTargets]
    .filter((target) => !localTargets.has(target))
    .map((target) => ({ target }))
    .sort(compareBy((e) => e.target))
  return [...local, ...propagated]
}
