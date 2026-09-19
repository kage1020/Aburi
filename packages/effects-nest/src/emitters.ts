import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_NEST_PLUGIN_NAME } from "./constants"

/**
 * Module specifiers that supply an `EventEmitter2`: the NestJS wrapper that registers it
 * in the DI container, and the underlying library. Node's built-in `events` / `stream`
 * emitters are deliberately out — they are per-instance state, not an application-wide
 * bus, and a stream's `.emit('data', ...)` would drown the diff report in noise.
 */
const NEST_EMITTER_MODULES_LIST = ["@nestjs/event-emitter", "eventemitter2"] as const

export type NestEmitterModule = (typeof NEST_EMITTER_MODULES_LIST)[number]

export const NEST_EMITTER_MODULES: ReadonlySet<NestEmitterModule> = new Set(
  NEST_EMITTER_MODULES_LIST,
)

function isNestEmitterModule(source: string): boolean {
  return (NEST_EMITTER_MODULES as ReadonlySet<string>).has(source)
}

/** True when the file imports a recognized event-emitter module; see `hasMatchingImport`. */
export function hasNestEmitterImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath },
    isNestEmitterModule,
  )
}

/**
 * Receivers whose `.emit(...)` classifies as `event.publish`: `eventBus`, the conventional
 * DI'd name, and the `EventEmitter2` class itself for singleton-style static usage.
 * User-named emitters (`bus`, `notifier`, `dispatcher`) and `socket` / `process` /
 * `stream` are out of scope: they are not universally domain events, and a name match
 * without the import gate would over-classify.
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
 * The one method classified as `event.publish`. EventEmitter2's `.emitAsync` /
 * `.emitAsyncSerial` are real publish APIs left out until the IR's async-effect confidence
 * model is settled, so recognition does not lock in a shape that would need unwinding.
 */
export const NEST_EMIT_METHOD = "emit" as const
export type NestEmitMethod = typeof NEST_EMIT_METHOD

export function isNestEmitMethod(name: string): name is NestEmitMethod {
  return name === NEST_EMIT_METHOD
}
