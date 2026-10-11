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

export function classifyPrismaCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath: ctx.file.path }

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

  // A computed model says nothing about the shape, so the receiver alone must name a client.
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
