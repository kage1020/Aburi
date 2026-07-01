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
 * An unintended reorder of effects registers as a hash change on purpose: transaction and
 * idempotency semantics depend on the actual side-effect order, so noise from a genuine
 * reorder is cheaper than missing a semantics-changing bug.
 *
 * Effect.id is also intentionally excluded from the input. Two effects that hit the same
 * `target` string are treated as identical logic even if the plugin classified them
 * differently (e.g. `db.write` vs `x-prisma:create`). This is what keeps time-series
 * comparisons stable across `config.effects[]` reshuffles — the target string carries the
 * semantic identity, the id carries the plugin's opinion.
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
  // Rules are consumed in the order they arrive (upstream IR generation is responsible
  // for placing them in source-order-by-line). Do not re-sort — the execution sequence
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
  // Keep source order: transaction and idempotency semantics depend on the actual
  // side-effect sequence. Effect.id is excluded so the plugin's classification opinion
  // does not perturb the hash for the same call target.
  return effects.map((e) => ({ target: normalizeFingerprintString(e.target) }))
}
