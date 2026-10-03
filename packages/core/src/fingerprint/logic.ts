import type { Effect, Symbol as IRSymbol, Rule } from "@aburi/types"
import { compareBy } from "../order"
import { hashCanonicalObject } from "./hash"
import { normalizeFingerprintString } from "./string"

/**
 * Shape of the logic fingerprint input. Locked with the same versioning rule as api, and the lock
 * reaches past the field set: which entries each array holds, and in what order, are hashed too,
 * so changing either moves every previously-computed `logic` value just as adding a field does.
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
 *   - effects: side effects by `target` string only, in two segments (`canonicalizeEffects`).
 *     Locally-detected effects come first, kept in call order because transaction and
 *     idempotency semantics depend on the actual side-effect sequence. Propagated effects
 *     have no call site to order them by, so they follow sorted by target, each target once
 *     and none the first segment already names.
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

/**
 * Locally-detected effects in call order (fingerprint.md §4.7), then the propagated ones by
 * target: sorted, each target once, and none the local segment already names (fingerprint.md
 * §4.1).
 *
 * The local segment is read as it stands, because its order and its repeats are the body's own: a
 * target called twice is two side effects. The propagated segment has neither. The IR sorts it by
 * `(id, target)` and merges it on that pair (effect-propagation.md §5.1, §8), but only the target
 * is hashed (fingerprint.md §4.5), so reading the segment as stored lets an id change move a
 * caller's `logic` while the callee's, whose local effects keep call order, stays put:
 *
 *   - order: `db.write` → `x-acme:create` on one entry sorts it past an `event.publish` beside it;
 *   - count: a target that two callees classify under different ids is two entries until the
 *     ids agree, and one after;
 *   - local suppression: propagation drops a propagated entry only when the caller has a local
 *     effect with the same `(id, target)`, so a local `db.write` on a target leaves a propagated
 *     `x-acme:create` on that target in place until the ids agree.
 *
 * Reading the segment by target alone leaves the ids no say in any of the three. Propagated
 * entries have no call-site position, and propagation already merges their repeats, so nothing
 * fingerprint.md §4.7 protects is lost.
 *
 * This is done here rather than in propagation so the IR stays as effect-propagation.md defines
 * it: ordered by `(id, target)`, the order integrity invariant #11 checks and IRs already written
 * must keep passing, and merged on that pair, which the diff's effect delta pairs on.
 */
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
