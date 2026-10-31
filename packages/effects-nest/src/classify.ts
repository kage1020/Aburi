import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, EFFECTS_NEST_PLUGIN_NAME } from "./constants"
import {
  hasNestEmitterImport,
  isNestEmitMethod,
  isNestEventEmitterIdentifier,
  NEST_EMITTER_CLASS,
  namesNestEmitterClass,
} from "./emitters"

export function classifyNestCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasNestEmitterImport(ctx.file.imports, ctx.file.path)) return null

  if (!isNestEmitMethod(method)) return null

  // The `undefined` arm is the two-segment minimum: a bare `emit()` has no receiver to read.
  const nameSegment = segments[segments.length - 2]
  if (nameSegment === undefined) return null
  if (isNestEventEmitterIdentifier(nameSegment)) return publish(`${nameSegment}.${method}`)

  const { receiverType } = call
  if (receiverType === undefined) return null
  if (!namesNestEmitterClass(ctx.file.imports, receiverType, ctx.file.path)) return null
  return publish(`${NEST_EMITTER_CLASS}.${method}`)
}

function publish(evidence: string): EffectClassification {
  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${evidence}`,
  }
}
