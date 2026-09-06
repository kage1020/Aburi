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
 * Three load-bearing design decisions this function encodes:
 *
 * **1. Chain-collapse.** Drizzle is a fluent builder — a single query like
 *    `await db.select().from(u).where(w)` causes `walkBody` to emit one CallCandidate
 *    per link in the chain (`db.select`, `db.select.from`, `db.select.from.where`).
 *    Only ONE of these should turn into an effect — otherwise a single SQL statement
 *    would produce N `db.read` records. The classifier drops every candidate whose
 *    target has a fluent-root verb (`select` / `selectDistinct` / `selectDistinctOn` /
 *    `insert` / `update` / `delete`) in an INTERNAL segment, so exactly the root
 *    survives and anchors the effect at the query origin line.
 *
 * **2. The import gate is not a receiver check.** Drizzle's normal shape is 2-segment
 *    (`db.select()`), so we CANNOT reuse `@aburi/effects-prisma`'s "require ≥3 segments"
 *    filter — every unrelated `store.select(...)` (RxJS) or `router.delete(...)` (Express)
 *    has the same shape. The import gate answers "does this file use Drizzle", which an
 *    Express router file is free to answer yes to: Express + Drizzle is one of the most
 *    common pairings there is, and a route table sits in the same file as the queries it
 *    runs often enough that the gate cannot be the last word. So a literal first argument
 *    rejects the route registration outright — no Drizzle root takes one — and the
 *    receiver and the argument count decide the tier.
 *
 * **3. Everything short of that downgrades rather than drops.** Where the receiver names a
 *    client binding and the call fits the terminal's signature the classification lands at
 *    `high`; where it does not, the effect is still emitted at `medium`, because a
 *    syntactic classifier cannot tell a client under a house naming convention apart from
 *    an unrelated object of the same shape, and silently dropping the first is as wrong as
 *    confidently claiming the second. See `classificationConfidence`.
 *
 * Throws when the language plugin emits a malformed target (empty string, adjacent
 * dots) — see `assertNonEmptySegments`. Callers should treat a thrown error as an
 * upstream contract violation, not a classification decision.
 *
 * Pure with respect to plugin state — matches the per-call timeout budget the core
 * enforces (effect-plugin.md §5.1.1).
 */
export function classifyDrizzleCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why the
  // order is load-bearing.
  const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasDrizzleImport(ctx.file.imports, ctx.file.path)) return null

  // A root Drizzle call is always at least 2 segments (`<client>.select()` and friends).
  // A bare identifier like `select()` has no client receiver and is not Drizzle.
  if (parts.length < 2) return null

  // Chain-collapse: reject downstream links of an already-classified chain. If any of
  // the fluent-root verbs sits in an INTERNAL position (neither the first nor the last
  // segment) this candidate is a `.from(...)` / `.where(...)` / `.set(...)` link and
  // its root has already classified.
  const fluentRoots = DRIZZLE_FLUENT_ROOT_METHODS as ReadonlySet<string>
  for (const segment of parts.slice(1, -1)) {
    if (fluentRoots.has(segment)) return null
  }

  // Relational query API: `<client>.query.<table>.findMany|findFirst` (4+ segments).
  // Checked BEFORE the generic terminal dispatch because the query API's terminal
  // (`findMany` / `findFirst`) is not in `DRIZZLE_READ_METHODS` — the generic branch
  // would fall through to null for a valid relational query call. The `<table>`
  // segment sits at index -2 and `query` sits at index -3, regardless of how many
  // receiver segments prefix the chain (`db.query.users.findMany` at length 4,
  // `this.db.query.users.findMany` at length 5, ...) — which puts the client at -4.
  if (parts.length >= 4 && parts.at(-3) === "query" && isDrizzleQueryMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.read",
      confidence: classificationConfidence(parts.at(-4), call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  // Every remaining shape is a call directly on the client, so the client is at -2.
  const client = parts.at(-2)

  if (isDrizzleReadMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.read",
      confidence: classificationConfidence(client, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isDrizzleWriteMethod(method)) {
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.write",
      confidence: classificationConfidence(client, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:write`,
    }
  }

  if (isDrizzleTransactionMethod(method)) {
    // Both `transaction(cb)` and `batch([...])` are API-required to take at least one
    // argument. A CallCandidate with argCount=0 whose shape matches means the source
    // code is genuinely broken at runtime, OR the language plugin emitted a malformed
    // candidate — either way it is an upstream signal we should not silently swallow
    // (which would conflate "broken input" with "not a Drizzle call"). Throw so the
    // caller sees the problem loudly. This is a rare edge case — well-formed Drizzle
    // code never reaches this branch with argCount=0.
    //
    // It runs before anything else this branch does: a violated contract is not a
    // classification decision, so nothing is spent weighing a call the caller has already
    // been told is broken.
    if (call.argumentCount < 1) {
      throw new Error(
        `${EFFECTS_DRIZZLE_PLUGIN_NAME} (${ctx.file.path}, line ${call.line}): "${call.target}" call has argCount=0 but Drizzle's transaction/batch API requires at least one argument (callback or statement array)`,
      )
    }
    // A transaction takes a callback or an array of statements, never `"a string"`.
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.transaction",
      confidence: classificationConfidence(client, call, maxArgumentsFor(method)),
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:tx`,
    }
  }

  return null
}
