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
 * Two load-bearing design decisions this function encodes:
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
 * **2. Import gate is the sole false-positive defense.** Drizzle's normal shape is
 *    2-segment (`db.select()`), so we CANNOT reuse `@aburi/effects-prisma`'s
 *    "require ≥3 segments" filter — every unrelated `store.select(...)` (RxJS) or
 *    `router.delete(...)` (Express) would match the same shape. Only files that
 *    import `drizzle-orm` (or any `drizzle-orm/*` driver subpath) pass the gate.
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
  // Fail-fast runs BEFORE the import gate so a malformed target throws on every file,
  // not just the ~1% that import Drizzle. Ordering the other way lets the same bug
  // surface only in Drizzle-consuming files and stay silent everywhere else —
  // catastrophic for reproducing upstream language-plugin bugs.
  const parts = assertNonEmptySegments(call.target, ctx.file.path)

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

  const method = parts[parts.length - 1]
  if (method === undefined) return null

  // Relational query API: `<client>.query.<table>.findMany|findFirst` (4+ segments).
  // Checked BEFORE the generic terminal dispatch because the query API's terminal
  // (`findMany` / `findFirst`) is not in `DRIZZLE_READ_METHODS` — the generic branch
  // would fall through to null for a valid relational query call. The `<table>`
  // segment sits at index -2 and `query` sits at index -3, regardless of how many
  // receiver segments prefix the chain (`db.query.users.findMany` at length 4,
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
    // Both `transaction(cb)` and `batch([...])` are API-required to take at least one
    // argument. A CallCandidate with argCount=0 whose shape matches means the source
    // code is genuinely broken at runtime, OR the language plugin emitted a malformed
    // candidate — either way it is an upstream signal we should not silently swallow
    // (which would conflate "broken input" with "not a Drizzle call"). Throw so the
    // caller sees the problem loudly. This is a rare edge case — well-formed Drizzle
    // code never reaches this branch with argCount=0.
    if (call.argumentCount < 1) {
      throw new Error(
        `effects-drizzle (${ctx.file.path}, line ${call.line}): "${call.target}" call has argCount=0 but Drizzle's transaction/batch API requires at least one argument (callback or statement array)`,
      )
    }
    return {
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: `${EFFECTS_DRIZZLE_DERIVED_BY_PREFIX}:tx`,
    }
  }

  return null
}

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target here would otherwise slip through the length gate and
 * false-classify — e.g. `"db..insert"` has three segments and would match a write
 * verb. `filePath` is threaded into the error message so caught exceptions in
 * production point at the offending source file.
 */
function assertNonEmptySegments(target: string, filePath: string): readonly string[] {
  if (target.length === 0) {
    throw new Error(
      `effects-drizzle (${filePath}): CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
    )
  }
  const parts = target.split(".")
  for (const segment of parts) {
    if (segment.length === 0) {
      throw new Error(
        `effects-drizzle (${filePath}): CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      )
    }
  }
  return parts
}
