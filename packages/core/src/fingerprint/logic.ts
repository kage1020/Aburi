import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { hashCanonicalObject } from "./hash"
import { normalizeFingerprintString } from "./string"

/**
 * Shape of the logic fingerprint input. Locked with the same versioning rule as api.
 */
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

/**
 * Compute the logic axis for a single Symbol.
 *
 * The logic axis captures what the body means at execution time:
 *   - rules: control-flow-significant constructs (guards / throws / returns / loops /
 *     try / switch / match). Kept in source order because control flow ordering matters.
 *   - effects: side effects by target string only. Effect.id is intentionally excluded so
 *     switching the effects plugin lineup does not perturb the hash for the same call
 *     (`prisma.invoice.create` classified as `db.write` and as `x-prisma:create` produce
 *     the same logic axis).
 *
 * decorators, signature, calls, and dropped decoration markers are NOT part of this axis.
 * The trade-off is documented in the design: an unintended reorder of effects is a
 * legitimate hash change (transaction / idempotency semantics depend on order).
 */
export function logicFingerprint(symbol: IRSymbol): string {
  return hashCanonicalObject(buildLogicInput(symbol))
}

function buildLogicInput(symbol: IRSymbol): LogicInput {
  return {
    effects: canonicalizeEffects(symbol.effects),
    rules: canonicalizeRules(symbol.rules),
  }
}

function canonicalizeRules(rules: readonly Rule[]): LogicInput["rules"] {
  // Rules are consumed in the order the IR carries them (integrity #11 requires that
  // order to be source-order-by-line already). Do not re-sort — the execution sequence
  // of a guard-then-throw-then-return is semantically distinct from throw-then-guard.
  return rules.map((r) => ({
    condition: r.condition !== null ? normalizeFingerprintString(r.condition) : null,
    expr: r.expr !== null ? normalizeFingerprintString(r.expr) : null,
    loopKind: r.loopKind ?? null,
    type: r.type,
    what: r.what !== null ? normalizeFingerprintString(r.what) : null,
  }))
}

function canonicalizeEffects(effects: readonly Effect[]): LogicInput["effects"] {
  // Same rationale as rules: keep source order. Effect.id is deliberately dropped from the
  // input so plugin-classification churn does not break time-series comparisons with older
  // IRs.
  return effects.map((e) => ({ target: normalizeFingerprintString(e.target) }))
}
