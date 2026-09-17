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
 * Compute the logic axis for a single Symbol: what the body means at execution time.
 *
 *   - rules: control-flow-significant constructs (guards / throws / returns / loops /
 *     try / switch / match), kept in source order because a guard-then-throw is not a
 *     throw-then-guard.
 *   - effects: side effects by `target` string only, kept in source order because
 *     transaction and idempotency semantics depend on the actual side-effect sequence.
 *     `Effect.id` is intentionally excluded so switching the effects plugin lineup does not
 *     perturb the hash for the same call: the target carries the semantic identity, the id
 *     carries the plugin's opinion (`db.write` vs `x-prisma:create` hash alike).
 *
 * decorators, signature, calls, and dropped decoration markers are NOT part of this axis.
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
  // Source order as delivered (the IR places rules by line); never re-sorted, see above.
  return rules.map((r) => ({
    condition: r.condition !== null ? normalizeFingerprintString(r.condition) : null,
    expr: r.expr !== null ? normalizeFingerprintString(r.expr) : null,
    loopKind: r.loopKind ?? null,
    type: r.type,
    what: r.what !== null ? normalizeFingerprintString(r.what) : null,
  }))
}

function canonicalizeEffects(effects: readonly Effect[]): LogicInput["effects"] {
  return effects.map((e) => ({ target: normalizeFingerprintString(e.target) }))
}
