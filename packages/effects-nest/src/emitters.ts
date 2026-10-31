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
  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*" && edge.namespaceBinding !== undefined) {
      assertNamespaceBinding(edge.namespaceBinding, edge, origin)
    }
  }
  return imports.some((edge) => {
    if (!isNestEmitterModule(edge.source)) return false
    if (edge.symbols === "*") {
      return (
        edge.namespaceBinding !== undefined &&
        typeName === `${edge.namespaceBinding}.${NEST_EMITTER_CLASS}`
      )
    }
    const bound = bindings(edge.source)
    return edge.symbols.some((raw) => bound.has(raw))
  })

  function bindings(source: string): ReadonlySet<string> {
    const named = typeName === NEST_EMITTER_CLASS ? [NEST_EMITTER_CLASS] : []
    // `eventemitter2` also exports the class as its default; `@nestjs/event-emitter` has no default.
    const defaulted = source === "eventemitter2" ? [`default as ${typeName}`] : []
    return new Set([...named, `${NEST_EMITTER_CLASS} as ${typeName}`, ...defaulted])
  }
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
