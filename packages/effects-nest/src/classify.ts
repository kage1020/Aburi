import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { hasNestEmitterImport, isNestEmitMethod, isNestEventEmitterIdentifier } from "./emitters"

/**
 * Shared derivedBy namespace. Duplicated in `manifest.ts` `derivedByPrefixes` so the
 * registry can validate them at load time, but both point at the same string literal
 * here to keep them coupled at edit time too.
 */
export const EFFECTS_NEST_DERIVED_BY_PREFIX = "effects-plugin:nest" as const

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
  if (!hasNestEmitterImport(ctx.file.imports)) return null

  const parts = assertNonEmptySegments(call.target)
  const method = parts[parts.length - 1] ?? ""
  if (!isNestEmitMethod(method)) return null

  // `<name>.emit` needs at least two segments. A naked `emit()` is not a Nest event
  // publisher — it would be a locally-scoped helper — and stays unclassified.
  if (parts.length < 2) return null
  const nameSegment = parts[parts.length - 2] ?? ""
  if (!isNestEventEmitterIdentifier(nameSegment)) return null

  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${nameSegment}.${method}`,
  }
}

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment. A malformed target would
 * otherwise slip through the length gate and miscategorize — same fail-fast the
 * sibling classifier applies at its entry point.
 */
function assertNonEmptySegments(target: string): string[] {
  if (target.length === 0) {
    throw new Error(
      "effects-nest: CallCandidate.target is empty — language plugin emitted an unnormalized callee",
    )
  }
  const parts = target.split(".")
  for (const segment of parts) {
    if (segment.length === 0) {
      throw new Error(
        `effects-nest: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
      )
    }
  }
  return parts
}
