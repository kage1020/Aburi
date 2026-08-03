import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_NEST_PLUGIN_NAME } from "./constants"

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
const NEST_EMITTER_MODULES_LIST = ["@nestjs/event-emitter", "eventemitter2"] as const

export type NestEmitterModule = (typeof NEST_EMITTER_MODULES_LIST)[number]

export const NEST_EMITTER_MODULES: ReadonlySet<NestEmitterModule> = new Set(
  NEST_EMITTER_MODULES_LIST,
)

/** Membership test against the closed set of recognized emitter modules. */
function isNestEmitterModule(source: string): boolean {
  return (NEST_EMITTER_MODULES as ReadonlySet<string>).has(source)
}

/**
 * True when the file's import list contains a recognized event-emitter module. An
 * empty `edge.source` throws via the shared guard — the language plugin's contract is a
 * normalized non-empty specifier, and silently returning false would hide upstream bugs.
 *
 * `filePath` is required and threaded into any thrown error message so a caught
 * exception in production tooling (CI logs, error reporters) points directly at the
 * offending source file rather than a bare "empty source" string.
 */
export function hasNestEmitterImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath },
    isNestEmitterModule,
  )
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
 * scope today — they are not universally domain events, and a name-based match
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

/**
 * The single method name the plugin currently classifies as `event.publish`. Kept as a
 * literal so downstream derivedBy templates keep their precision.
 *
 * EventEmitter2 also ships `.emitAsync(event, ...args)` (Promise-returning variant) and
 * `.emitAsyncSerial` (serial variant). Those are legitimate publish APIs but sit
 * outside the current scope — a future patch can add them alongside the sync `.emit` once the
 * IR's async-effect confidence model is settled. Recognition is deliberately narrow
 * until then so we do not lock in a shape we would then need to unwind.
 */
export const NEST_EMIT_METHOD = "emit" as const
export type NestEmitMethod = typeof NEST_EMIT_METHOD

export function isNestEmitMethod(name: string): name is NestEmitMethod {
  return name === NEST_EMIT_METHOD
}
