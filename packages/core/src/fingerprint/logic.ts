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

/** The rule fields that classify a rule rather than say anything about the body it is in. */
const SHAPE_ONLY_RULE_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "loopKind",
] satisfies (keyof LogicInput["rules"][number])[])

/**
 * Whether a Symbol's logic axis names nothing: no effect, and no rule carrying anything but its
 * `type` and `loopKind`. Those two say what shape a body has, not what it does, and unrelated
 * bodies share them — every class and every body that only calls something hash to one value,
 * every body that is one `for` loop over calls to another. So two Symbols agreeing on such an
 * axis have not shown they are one, and the diff's logic-fingerprint stage asks their names to
 * (diff-algorithm.md §3.3).
 *
 * Read off the same input the hash is, field by field, so a field this axis gains later counts
 * as naming something until it is added to `SHAPE_ONLY_RULE_FIELDS`.
 */
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
