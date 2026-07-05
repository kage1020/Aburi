import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { hasNestEmitterImport, isNestEmitMethod, isNestEventEmitterIdentifier } from "./emitters"

/**
 * Shared derivedBy namespace. `manifest.ts` imports this same const for its
 * `derivedByPrefixes` entry, so the classifier's tag builder and the registry
 * declaration cannot drift.
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
  // Fail-fast runs BEFORE the import gate so a malformed target throws on every file,
  // not just the ~1% that import a Nest emitter. Ordering the other way lets the same
  // bug surface only in Nest-consuming files and stay silent everywhere else —
  // catastrophic for reproducing upstream language-plugin bugs.
  const parts = assertNonEmptySegments(call.target)

  if (!hasNestEmitterImport(ctx.file.imports)) return null

  // `parts` is a NonEmptySegments tuple by contract, but `at()`'s general signature
  // still widens to `string | undefined`. `.at(-1) as string` records the intent
  // without a non-null assertion (Biome disallows `!` under noNonNullAssertion).
  const method = parts.at(-1) as string
  if (!isNestEmitMethod(method)) return null

  // `<name>.emit` needs at least two segments. A naked `emit()` is not a Nest event
  // publisher — it would be a locally-scoped helper — and stays unclassified.
  if (parts.length < 2) return null
  const nameSegment = parts.at(-2) as string
  if (!isNestEventEmitterIdentifier(nameSegment)) return null

  return {
    effectId: "event.publish",
    confidence: "high",
    derivedBy: `${EFFECTS_NEST_DERIVED_BY_PREFIX}:${nameSegment}.${method}`,
  }
}

/**
 * A non-empty split — after `assertNonEmptySegments` runs there is guaranteed to be at
 * least one segment, so the tuple type reflects that and the classifier can index
 * without a non-null assertion.
 */
type NonEmptySegments = readonly [string, ...string[]]

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment. A malformed target would
 * otherwise slip through the length gate and miscategorize — same fail-fast the
 * sibling classifier applies at its entry point.
 */
function assertNonEmptySegments(target: string): NonEmptySegments {
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
  // Split of a non-empty string yields at least one segment, and the loop above ruled
  // out empty segments — the tuple assertion here reflects a proven invariant.
  return parts as unknown as NonEmptySegments
}
