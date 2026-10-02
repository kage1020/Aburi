import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_DRIZZLE_DERIVED_BY_PREFIX, EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"
import { hasDrizzleImport } from "./imports"
import {
  DRIZZLE_FLUENT_ROOT_METHODS,
  isDrizzleQueryMethod,
  isDrizzleReadMethod,
  isDrizzleTransactionMethod,
  isDrizzleWriteMethod,
  maxArgumentsFor,
} from "./methods"
import { classificationConfidence } from "./receivers"

/**
 * Classify a CallCandidate against Drizzle ORM conventions.
 *
 * Four decisions this function encodes:
 *
 * 1. **Chain-collapse.** Drizzle is a fluent builder, so `walkBody` emits one candidate per
 *    link of `db.select().from(u).where(w)` (`db.select`, `db.select.from`, ...). Only the
 *    root may classify, or one statement would yield N `db.read` records: any candidate
 *    with a fluent-root verb in an internal segment is dropped.
 * 2. **The import gate is not a receiver check.** Drizzle's normal shape is two segments
 *    (`db.select()`), the same as RxJS `store.select(...)` and Express `router.delete(...)`,
 *    and Express + Drizzle commonly share a file. A literal first argument rejects a route
 *    registration outright — no Drizzle root takes one — and the receiver plus argument
 *    count decide the tier.
 * 3. **Everything short of that downgrades rather than drops** — see `receiverConfidence`.
 * 4. **Arity has a floor for `transaction` / `batch`.** Both require an argument, so a
 *    zero-argument call is dropped whatever the receiver, where an overflow only costs the
 *    tier (effect-plugin.md §5.4).
 *
 * Throws only through the registry's input guards — `assertNonEmptySegments` on the target
 * and `hasMatchingImport` on each `ImportEdge.source` — upstream contract violations rather
 * than classification decisions. Pure with respect to plugin state (effect-plugin.md).
 */
export function classifyDrizzleCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why.
  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasDrizzleImport(ctx.file.imports, ctx.file.path)) return null

  // A bare `select()` has no client receiver and is not Drizzle.
  if (segments.length < 2) return null

  // Chain-collapse: a fluent-root verb in an internal segment marks a downstream link.
  const fluentRoots = DRIZZLE_FLUENT_ROOT_METHODS as ReadonlySet<string>
  for (const segment of segments.slice(1, -1)) {
    if (fluentRoots.has(segment)) return null
  }

  // Relational query API: `<client>.query.<table>.findMany|findFirst`. Checked before the
  // generic dispatch because its terminals are not read methods. `query` sits at -3 and
  // the client at -4 however many receiver segments precede them.
  if (segments.length >= 4 && segments.at(-3) === "query" && isDrizzleQueryMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.read",
      confidence: classificationConfidence(segments.at(-4), call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  // Every remaining shape is a call directly on the client, so the client is at -2.
  const clientSegment = segments.at(-2)

  if (isDrizzleReadMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.read",
      confidence: classificationConfidence(clientSegment, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isDrizzleWriteMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.write",
      confidence: classificationConfidence(clientSegment, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:write`,
    }
  }

  if (isDrizzleTransactionMethod(method)) {
    // `transaction(cb)` and `batch([...])` both require an argument, so no Drizzle signature
    // reaches a zero-argument call: a Firestore `batch()`, an unmanaged Sequelize or Knex
    // `transaction()`, or a class's own method. Not separable from broken source here, and a
    // withdrawn file is the costlier of the two mistakes, so it is handed on unclassified.
    if (call.argumentCount < 1) return null
    // A transaction takes a callback or a statement array, never a literal.
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.transaction",
      confidence: classificationConfidence(clientSegment, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:tx`,
    }
  }

  return null
}
