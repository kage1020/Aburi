import {
  assertNonEmptySegments,
  hasLiteralFirstArgument,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import {
  type CallCandidate,
  type ClassifyContext,
  COMPUTED_TARGET_SEGMENT,
  type EffectClassification,
} from "@aburi/types"
import { EFFECTS_PRISMA_DERIVED_BY_PREFIX, EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"
import { hasPrismaImport } from "./imports"
import { isPrismaReadMethod, isPrismaTransactionMethod, isPrismaWriteMethod } from "./methods"
import {
  classificationConfidence,
  namesPrismaClient,
  PRISMA_DELEGATE_MAX_ARGUMENTS,
  PRISMA_TRANSACTION_MAX_ARGUMENTS,
} from "./receivers"

/**
 * Classify a CallCandidate against Prisma Client conventions.
 *
 * Two shapes are accepted once the file imports a Prisma Client module (`hasPrismaImport`):
 *   - `<...>.<model>.<verb>` (3+ segments) — a model delegate call. The client segment is
 *     what separates it from two-segment collisions such as Express `router.create(...)`.
 *   - `<...>.$transaction` (2+ segments) — the transaction API on the client itself.
 *
 * The import gate is not a receiver check: `this.cache.items.delete(key)` is a `Map` and
 * `session.user.update(fields)` an object, both three segments with a delegate verb in a
 * file that also uses Prisma. A literal first argument rules a call out — no Prisma method
 * takes one — and the receiver plus argument count decide the tier, downgrading rather
 * than dropping (`receiverConfidence`). A model addressed through brackets arrives as
 * `<computed>` and supplies the third segment without a model, so there the receiver must
 * name a client outright.
 *
 * Throws on a malformed target (`assertNonEmptySegments`): an upstream contract violation,
 * not a classification decision. Pure with respect to plugin state (effect-plugin.md).
 */
export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why.
  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasPrismaImport(ctx.file.imports, ctx.file.path)) return null

  if (isPrismaTransactionMethod(method)) {
    // A bare `$transaction()` is not a Prisma call; the API is a method on the client.
    if (segments.length < 2) return null
    if (hasLiteralFirstArgument(call)) return null
    return {
      effectId: "db.transaction",
      confidence: classificationConfidence(segments.at(-2), call, PRISMA_TRANSACTION_MAX_ARGUMENTS),
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:tx`,
    }
  }

  // `<client>.<model>.<verb>`: two-segment calls are `router.create(...)` and friends.
  if (segments.length < 3) return null

  // A delegate takes an options object or nothing, so `map.delete("id")` is another API.
  if (hasLiteralFirstArgument(call)) return null

  // The client sits immediately before the model, whatever precedes it.
  const clientSegment = segments.at(-3)

  // `prisma[model].create(…)` arrives as `prisma.<computed>.create`: three segments, one of
  // which names nothing. Segment count is what separates a delegate call from
  // `queues[id].upsert(job)` / `sets[key].delete(item)`, so the receiver has to carry the
  // claim alone; `classificationConfidence` already answers `medium` on the same flag.
  if (clientSegment !== undefined && segments.at(-2) === COMPUTED_TARGET_SEGMENT) {
    if (!namesPrismaClient(clientSegment)) return null
  }

  const confidence = classificationConfidence(clientSegment, call, PRISMA_DELEGATE_MAX_ARGUMENTS)

  if (isPrismaReadMethod(method)) {
    return {
      effectId: "db.read",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:read`,
    }
  }

  if (isPrismaWriteMethod(method)) {
    return {
      effectId: "db.write",
      confidence,
      derivedBy: `${EFFECTS_PRISMA_DERIVED_BY_PREFIX}:write`,
    }
  }

  return null
}
