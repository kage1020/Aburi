import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_NEST_PLUGIN_NAME } from "./constants"

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

const NEST_EVENT_EMITTER_IDENTIFIERS_LIST = ["eventBus", "EventEmitter2"] as const

export type NestEventEmitterIdentifier = (typeof NEST_EVENT_EMITTER_IDENTIFIERS_LIST)[number]

export const NEST_EVENT_EMITTER_IDENTIFIERS: ReadonlySet<NestEventEmitterIdentifier> = new Set(
  NEST_EVENT_EMITTER_IDENTIFIERS_LIST,
)

export function isNestEventEmitterIdentifier(name: string): name is NestEventEmitterIdentifier {
  return (NEST_EVENT_EMITTER_IDENTIFIERS as ReadonlySet<string>).has(name)
}

export const NEST_EMIT_METHOD = "emit" as const
export type NestEmitMethod = typeof NEST_EMIT_METHOD

export function isNestEmitMethod(name: string): name is NestEmitMethod {
  return name === NEST_EMIT_METHOD
}
