import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, EFFECTS_NEST_PLUGIN_NAME } from "./constants"
import { hasNestEmitterImport, isNestEmitMethod, isNestEventEmitterIdentifier } from "./emitters"

/**
 * Classify a CallCandidate against NestJS event-emitter conventions. Two signals must
 * both hold: the file imports a recognized emitter module (`hasNestEmitterImport`), and the
 * target ends in `<eventBus|EventEmitter2>.emit`. The import gate drops `.emit` on streams
 * and sockets in files that never import the emitter; the name gate drops `socket.emit`
 * in files that do.
 *
 * Throws on a malformed target (`assertNonEmptySegments`): an upstream contract violation,
 * not a classification decision. Pure with respect to plugin state (effect-plugin.md).
 */
export function classifyNestCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why.
  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasNestEmitterImport(ctx.file.imports, ctx.file.path)) return null

  if (!isNestEmitMethod(method)) return null

  // The `undefined` arm is the two-segment minimum: a bare `emit()` has no receiver to read.
  const nameSegment = segments[segments.length - 2]
  if (nameSegment === undefined || !isNestEventEmitterIdentifier(nameSegment)) return null

  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${nameSegment}.${method}`,
  }
}
