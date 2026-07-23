import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { hasDrizzleImport } from "./imports"
import {
  DRIZZLE_FLUENT_ROOT_METHODS,
  isDrizzleQueryMethod,
  isDrizzleReadMethod,
  isDrizzleTransactionMethod,
  isDrizzleWriteMethod,
} from "./methods"

/**
 * Shared derivedBy namespace. `manifest.ts` imports this same const for its
 * `derivedByPrefixes` entry, so the classifier's tag builder and the registry
 * declaration cannot drift.
 */
export const EFFECTS_DRIZZLE_DERIVED_BY_PREFIX = "effects-plugin:drizzle" as const

/**
 * Classify a CallCandidate against Drizzle ORM conventions.
 *
 * Drizzle is a fluent builder. A single query like `await db.select().from(u).where(w)`
 * causes `walkBody` to emit multiple CallCandidates (one per link in the chain):
 *   - `db.select`
 *   - `db.select.from`
 *   - `db.select.from.where`
 * Only ONE of these should turn into an effect — otherwise a single SQL statement
 * would produce N `db.read` records. The classifier keeps this
 * **one-classification-per-chain** invariant by:
 *
 *   1. Fail-fast validating the target (throws on empty / malformed input).
 *   2. Gating on `drizzle-orm` (or any `drizzle-orm/*` driver subpath) being imported.
 *      Drizzle's normal shape is 2-segment (`db.select()`), so we CANNOT reuse
 *      `@aburi/effects-prisma`'s "require ≥3 segments" false-positive gate — every
 *      unrelated `store.select(...)` (RxJS) or `router.delete(...)` (Express) would be
 *      the same shape. The import gate is the sole defense.
 *   3. Rejecting any target whose INTERNAL segments contain one of the fluent-root
 *      verbs (`select` / `selectDistinct` / `selectDistinctOn` / `insert` / `update` /
 *      `delete`). This turns the 3-link chain above into: only `db.select` (root)
 *      classifies, the other two are dropped because their internal segments include
 *      `select`.
 *   4. Dispatching on the trailing method segment, preferring the relational query API
 *      (`db.query.<table>.findMany|findFirst`, 4+ segments with `query` at index -3)
 *      before the generic terminals so a `findMany` call is not misinterpreted as a
 *      chained internal segment.
 *   5. Emitting `{ effectId, confidence: "high", derivedBy: "effects-plugin:drizzle:<verb>" }`.
 *
 * The function is a pure lookup — no I/O, no state, no async — matching the per-call
 * timeout budget the core enforces (effect-plugin.md §5.1.1).
 */
export function classifyDrizzleCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  // Fail-fast runs BEFORE the import gate so a malformed target throws on every file,
  // not just the ~1% that import Drizzle. Ordering the other way lets the same bug
  // surface only in Drizzle-consuming files and stay silent everywhere else —
  // catastrophic for reproducing upstream language-plugin bugs.
  const parts = assertNonEmptySegments(call.target)

  if (!hasDrizzleImport(ctx.file.imports)) return null

  // A root Drizzle call is always at least 2 segments (`<client>.select()` and friends).
  // A bare identifier like `select()` has no client receiver and is not Drizzle.
  if (parts.length < 2) return null

  // Chain-collapse: reject downstream links of an already-classified chain. If any of
  // the fluent-root verbs sits in an INTERNAL position (neither the first nor the last
  // segment) this candidate is a `.from(...)` / `.where(...)` / `.set(...)` link and
  // its root has already classified.
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (DRIZZLE_FLUENT_ROOT_METHODS.has(parts[i] as string)) return null
  }

  const method = parts.at(-1) as string

  // Relational query API: `<client>.query.<table>.findMany|findFirst` (4+ segments).
  // The `<table>` segment sits at index -2 and `query` sits at index -3, regardless of
  // how many receiver segments prefix the chain (`db.query.users.findMany` at length 4,
  // `this.db.query.users.findMany` at length 5, ...).
  if (parts.length >= 4 && parts.at(-3) === "query" && isDrizzleQueryMethod(method)) {
    return {
      effectId: "db.read",
      confidence: "high",
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isDrizzleReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence: "high",
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isDrizzleWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence: "high",
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:write`,
    }
  }

  if (isDrizzleTransactionMethod(method)) {
    // Both `transaction(cb)` and `batch([...])` take at least one argument (the callback
    // or the statement array). Rejecting argCount=0 filters out property accesses that
    // syntactically resemble a bare call — the language plugin should not emit those,
    // but we guard defensively.
    if (call.argumentCount < 1) return null
    return {
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:tx`,
    }
  }

  return null
}

/**
 * A non-empty split — after `assertNonEmptySegments` runs there is guaranteed to be at
 * least one segment, so the tuple type reflects that.
 */
type NonEmptySegments = readonly [string, ...string[]]

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target here would otherwise slip through the length gate and
 * false-classify — e.g. `"db..insert"` has three segments and would match a write
 * verb — so this is the fail-fast the sibling classifiers apply at their entry points.
 */
function assertNonEmptySegments(target: string): NonEmptySegments {
  if (target.length === 0) {
    throw new Error(
      "effects-drizzle: CallCandidate.target is empty — language plugin emitted an unnormalized callee",
    )
  }
  const parts = target.split(".")
  for (const segment of parts) {
    if (segment.length === 0) {
      throw new Error(
        `effects-drizzle: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      )
    }
  }
  return parts as unknown as NonEmptySegments
}
