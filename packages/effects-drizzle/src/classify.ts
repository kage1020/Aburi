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
  minArgumentsFor,
} from "./methods"
import { classificationConfidence } from "./receivers"

export function classifyDrizzleCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasDrizzleImport(ctx.file.imports, ctx.file.path)) return null

  // A bare `select()` has no client receiver and is not Drizzle.
  if (segments.length < 2) return null

  // Chain-collapse: a fluent-root verb in an internal segment marks a downstream link.
  const fluentRoots = DRIZZLE_FLUENT_ROOT_METHODS as ReadonlySet<string>
  for (const segment of segments.slice(1, -1)) {
    if (fluentRoots.has(segment)) return null
  }

  // Every Drizzle write and transaction takes an argument, so a bare call is another API's.
  if (call.argumentCount < minArgumentsFor(method)) return null

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
