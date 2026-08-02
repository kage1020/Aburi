import { assertNonEmptySegments } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"
import { hasPrismaImport } from "./imports"
import { isPrismaReadMethod, isPrismaTransactionMethod, isPrismaWriteMethod } from "./methods"

/**
 * Classify a CallCandidate against Prisma Client conventions.
 *
 * Recognition strategy:
 *   1. The owning file must import a Prisma Client module (see `hasPrismaImport`). No
 *      import → `null`, so callers can chain other effect plugins after this one.
 *   2. The target is split on `.`; the plugin looks at the trailing segments to match
 *      Prisma's fixed client surface. Two shapes are accepted:
 *        - `<...>.<model>.<verb>` (3+ segments) — a model delegate call. The client
 *          segment stops two-segment method collisions (Express `router.create(...)`)
 *          from false-classifying.
 *        - `<...>.$transaction` (2+ segments) — the top-level transaction API on the
 *          client itself.
 *   3. Malformed targets (empty string, adjacent / leading / trailing dots) throw — the
 *      language plugin's contract is a normalized non-empty callee, so a violation
 *      here is an upstream bug we surface loudly instead of silently miscategorizing.
 *
 * The function is a pure lookup — no I/O, no state, no async — matching the per-call
 * timeout budget the core enforces (effect-plugin.md §5.1.1).
 */
export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin = { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate so a malformed target throws on every file,
  // not just the ~1% that import Prisma. Ordering the other way lets the same bug
  // surface only in Prisma-consuming files and stay silent everywhere else —
  // catastrophic for reproducing upstream language-plugin bugs.
  const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasPrismaImport(ctx.file.imports, ctx.file.path)) return null

  if (isPrismaTransactionMethod(method)) {
    // Bare `$transaction()` (single segment) is not a Prisma call — the transaction
    // API only makes sense as a method on the client (`<client>.$transaction(...)`).
    if (parts.length < 2) return null
    return {
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:tx`,
    }
  }

  // Model delegate calls need `<client>.<model>.<verb>` to distinguish them from
  // unrelated two-segment method calls (Express `router.create(...)`, an Array's
  // hypothetical `.findMany` collision) that would otherwise false-positive in files
  // that colocate Prisma with another library.
  if (parts.length < 3) return null

  if (isPrismaReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence: "high",
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isPrismaWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence: "high",
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:write`,
    }
  }

  return null
}
