import {
  assertImportEdgeSource,
  assertNamespaceBinding,
  hasMatchingImport,
} from "@aburi/plugin-registry/plugin-input"
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

export function hasNestEmitterImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath },
    isNestEmitterModule,
  )
}

export const NEST_EMITTER_CLASS = "EventEmitter2" as const

export function namesNestEmitterClass(
  imports: readonly ImportEdge[],
  typeName: string,
  filePath: string,
): boolean {
  const origin = { plugin: EFFECTS_NEST_PLUGIN_NAME, filePath }
  return imports.some((edge) => {
    assertImportEdgeSource(edge, origin)
    if (!isNestEmitterModule(edge.source)) return false
    if (edge.symbols === "*") {
      const binding = edge.namespaceBinding
      if (binding === undefined) return false
      assertNamespaceBinding(binding, edge, origin)
      return typeName === `${binding}.${NEST_EMITTER_CLASS}`
    }
    return edge.symbols.some(
      (raw) =>
        (raw === NEST_EMITTER_CLASS && typeName === NEST_EMITTER_CLASS) ||
        raw === `${NEST_EMITTER_CLASS} as ${typeName}`,
    )
  })
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
