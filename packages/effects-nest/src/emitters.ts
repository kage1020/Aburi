import type { ImportEdge } from "@aburi/types"

/**
 * npm module specifiers that supply an `EventEmitter2` — the `.emit(...)` publisher the
 * plugin recognizes. Any file that pulls in one of these is treated as a NestJS
 * event-emitter consumer.
 *
 * - `@nestjs/event-emitter` — the NestJS wrapper package that re-exports `EventEmitter2`
 *   and registers it in the DI container.
 * - `eventemitter2` — the underlying library. Direct imports are less common than the
 *   NestJS wrapper but still valid usage.
 *
 * Node's built-in `events` and `stream` modules are intentionally omitted — those
 * emitters follow a different lifecycle (per-instance state, not DI'd application-wide
 * bus) and misclassifying a stream's `.emit('data', ...)` as a domain event would drown
 * the diff report in noise.
 */
const NEST_EMITTER_MODULES: ReadonlySet<string> = new Set([
  "@nestjs/event-emitter",
  "eventemitter2",
])

/**
 * True when the file's import list contains a recognized event-emitter module. An
 * empty `edge.source` throws — the language plugin's contract is a normalized non-empty
 * specifier, and silently returning false would hide upstream bugs.
 */
export function hasNestEmitterImport(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => {
    if (edge.source.length === 0) {
      throw new Error(
        "effects-nest: ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
      )
    }
    return NEST_EMITTER_MODULES.has(edge.source)
  })
}

/**
 * Recognized identifiers whose `.emit(...)` calls the plugin classifies as
 * `event.publish`. Single source of truth: the union type and runtime `Set` derive
 * from the same tuple so extension is a table edit.
 *
 * - `eventBus` — the conventional DI'd name for an EventEmitter2 instance.
 * - `EventEmitter2` — the class itself; direct static usage (`EventEmitter2.emit(...)`)
 *   is unusual but shows up in singleton patterns.
 *
 * Non-recognized emitters (`socket.emit(...)`, `process.emit(...)`, `stream.emit(...)`,
 * arbitrary user-named `bus`, `notifier`, `dispatcher`, ...) are intentionally out of
 * scope for v0.1 — they are not universally domain events, and a name-based match
 * without the two-signal defense would over-classify.
 */
const NEST_EVENT_EMITTER_IDENTIFIERS_LIST = ["eventBus", "EventEmitter2"] as const

export type NestEventEmitterIdentifier = (typeof NEST_EVENT_EMITTER_IDENTIFIERS_LIST)[number]

export const NEST_EVENT_EMITTER_IDENTIFIERS: ReadonlySet<NestEventEmitterIdentifier> = new Set(
  NEST_EVENT_EMITTER_IDENTIFIERS_LIST,
)

export function isNestEventEmitterIdentifier(name: string): name is NestEventEmitterIdentifier {
  return (NEST_EVENT_EMITTER_IDENTIFIERS as ReadonlySet<string>).has(name)
}

/** The single method name the plugin classifies. Kept as a literal for template reuse. */
export const NEST_EMIT_METHOD = "emit" as const
export type NestEmitMethod = typeof NEST_EMIT_METHOD

export function isNestEmitMethod(name: string): name is NestEmitMethod {
  return name === NEST_EMIT_METHOD
}
