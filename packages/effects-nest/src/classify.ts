import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_NEST_DERIVED_BY_PREFIX, EFFECTS_NEST_PLUGIN_NAME } from "./constants"
import { hasNestEmitterImport, isNestEmitMethod, isNestEventEmitterIdentifier } from "./emitters"

/**
 * Classify a CallCandidate against NestJS event-emitter conventions.
 *
 * Recognition strategy (two-signal defense):
 *   1. The owning file must import a recognized event-emitter module
 *      (see `hasNestEmitterImport`). Files that reference `.emit(...)` for streams,
 *      sockets, or unrelated node emitters do not carry these imports and fall through.
 *   2. The trailing two segments of the target must be `<name>.emit`, where `<name>`
 *      is one of the recognized identifiers (`eventBus` / `EventEmitter2`). The name
 *      hint is what stops `.emit` on random helper objects from false-classifying
 *      even when the file happens to import the emitter module.
 *
 * Both signals must be present. A file that imports `@nestjs/event-emitter` but calls
 * `socket.emit(...)` returns null; so does a file that has `eventBus.emit(...)` but
 * never imports the module. This mirrors the sibling `effects-prisma` layered gate.
 *
 * Malformed targets (empty string, adjacent / leading / trailing dots) throw — a
 * violation of the language plugin's normalized-callee contract is surfaced loudly
 * instead of silently miscategorizing.
 *
 * The function is a pure lookup — no I/O, no state, no async — matching the per-call
 * timeout budget the core enforces (effect-plugin.md §5.1.1).
 */
export function classifyNestCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath: ctx.file.path }

  // Fail-fast runs BEFORE the import gate — see `assertNonEmptySegments` for why the
  // order is load-bearing.
  const { segments: parts, last: method } = assertNonEmptySegments(call.target, origin)

  if (!hasNestEmitterImport(ctx.file.imports, ctx.file.path)) return null

  if (!isNestEmitMethod(method)) return null

  // `<name>.emit` needs at least two segments, and the `undefined` arm below IS that
  // requirement — a single-segment target has no receiver to read, so `emit()` on its own
  // (a locally-scoped helper, not a Nest publisher) exits here. Do not drop the arm as a
  // redundant `noUncheckedIndexedAccess` formality: it is the only thing keeping a naked
  // `emit()` unclassified.
  const nameSegment = parts[parts.length - 2]
  if (nameSegment === undefined || !isNestEventEmitterIdentifier(nameSegment)) return null

  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${nameSegment}.${method}`,
  }
}
