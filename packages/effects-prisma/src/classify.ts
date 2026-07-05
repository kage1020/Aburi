import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { hasPrismaImport } from "./imports"
import { isPrismaReadMethod, isPrismaTransactionMethod, isPrismaWriteMethod } from "./methods"

/**
 * Shared derivedBy namespace. Duplicated in `manifest.ts` `derivedByPrefixes` so a
 * registry check will flag divergence at load time, but both point at the same string
 * literal here to keep them coupled at edit time too.
 */
export const EFFECTS_PRISMA_DERIVED_BY_PREFIX = "effects-plugin:prisma" as const

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
  if (!hasPrismaImport(ctx.file.imports)) return null

  const parts = assertNonEmptySegments(call.target)
  const method = parts[parts.length - 1] ?? ""

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

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target here would otherwise slip through the length gate and
 * false-classify — e.g. `"prisma..create"` has three segments and would match a write
 * verb — so this is the fail-fast the sibling classifiers apply at their entry points.
 */
function assertNonEmptySegments(target: string): string[] {
  if (target.length === 0) {
    throw new Error(
      "effects-prisma: CallCandidate.target is empty — language plugin emitted an unnormalized callee",
    )
  }
  const parts = target.split(".")
  for (const segment of parts) {
    if (segment.length === 0) {
      throw new Error(
        `effects-prisma: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      )
    }
  }
  return parts
}
