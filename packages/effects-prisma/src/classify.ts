import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
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
 *        - `<...>.<model>.<verb>` — a model delegate call. `<verb>` decides read/write.
 *        - `<...>.$transaction` — the top-level transaction API on the client itself.
 *      The leading segments are irrelevant — `prisma.user.create` and
 *      `this.prisma.user.create` and `container.services.prisma.user.create` all
 *      resolve to the same effect. The design intentionally does not verify the leaf
 *      identifier is literally `prisma`; the import gate is the accuracy control.
 *   3. The classifier returns `null` for any callee whose trailing method is not on
 *      the Prisma delegate surface. Unrelated helpers colocated in a Prisma file flow
 *      through to the next plugin.
 *
 * The function is a pure lookup — no I/O, no state, no async — matching the per-call
 * timeout budget the core enforces (effect-plugin.md §5.1.1).
 */
export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  if (!hasPrismaImport(ctx.file.imports)) return null

  const parts = call.target.split(".")
  const method = parts.at(-1)
  if (method === undefined) return null

  if (isPrismaTransactionMethod(method)) {
    return {
      effectId: "db.transaction",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:tx",
    }
  }

  // Model-delegate calls need at least three segments — `<client>.<model>.<verb>` —
  // to be distinguishable from unrelated two-segment method calls (e.g. Express's
  // `router.create(...)` or an Array's `.findMany` name collision). Requiring the
  // client segment blocks those false positives even when the file happens to import
  // `@prisma/client` for a colocated reason.
  if (parts.length < 3) return null

  if (isPrismaReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:read",
    }
  }

  if (isPrismaWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence: "high",
      derivedBy: "effects-plugin:prisma:write",
    }
  }

  return null
}
