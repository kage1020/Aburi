import { DEFAULT_EXPORT_NAME, splitAliasedImportName } from "@aburi/core"
import {
  assertImportBinding,
  assertImportEdgeSource,
  assertNamespaceBinding,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { Confidence, Decorator, ImportEdge } from "@aburi/types"
import { FRAMEWORK_NESTJS_PLUGIN_NAME } from "./manifest"

const NESTJS_SCOPE = "@nestjs/"

export function isNestjsModule(source: string): boolean {
  return source.startsWith(NESTJS_SCOPE)
}

interface NameOrigin {
  readonly imported: string
  /** The module specifier the name came from, kept so a downgrade can say which module caused it. */
  readonly source: string
  readonly fromNestjs: boolean
}

interface NamespaceOrigin {
  readonly source: string
  readonly fromNestjs: boolean
  readonly origins: ReadonlyMap<string, string> | undefined
}

export interface ImportedBindings {
  /** A name the edges never mention is absent, unlike one attributed to a foreign module. */
  readonly names: ReadonlyMap<string, NameOrigin>
  readonly namespaces: ReadonlyMap<string, NamespaceOrigin>
}

export function readImportedNames(
  imports: readonly ImportEdge[],
  filePath: string,
): ImportedBindings {
  const origin: PluginInputOrigin = { plugin: FRAMEWORK_NESTJS_PLUGIN_NAME, filePath }
  const names = new Map<string, NameOrigin>()
  const namespaces = new Map<string, NamespaceOrigin>()

  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*") {
      const binding = edge.namespaceBinding
      if (binding === undefined) continue
      assertNamespaceBinding(binding, edge, origin)
      if (namespaces.get(binding)?.fromNestjs === true) continue
      namespaces.set(binding, {
        source: edge.source,
        fromNestjs: isNestjsModule(edge.source),
        origins: edge.origins,
      })
      continue
    }
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      if (names.get(binding.local)?.fromNestjs === true) continue
      const source = edge.origins?.get(binding.imported) ?? edge.source
      names.set(binding.local, {
        imported: binding.imported,
        source,
        fromNestjs: isNestjsModule(source),
      })
    }
  }

  return { names, namespaces }
}

export interface ResolvedDecoratorName {
  canonical: string
  confidence: Confidence
}

export function resolveDecoratorName(
  decorator: Pick<Decorator, "name" | "qualifier">,
  bindings: ImportedBindings,
): ResolvedDecoratorName {
  const { name, qualifier } = decorator
  if (qualifier !== undefined) {
    const head = headSegment(qualifier)
    const viaNamespace = bindings.namespaces.get(head)
    if (viaNamespace !== undefined) {
      const member = memberSegment(qualifier) ?? name
      const source = viaNamespace.origins?.get(member) ?? viaNamespace.source
      return { canonical: name, confidence: isNestjsModule(source) ? "high" : "medium" }
    }
    const viaName = bindings.names.get(head)
    if (viaName !== undefined) {
      return { canonical: name, confidence: viaName.fromNestjs ? "high" : "medium" }
    }
    return { canonical: name, confidence: "high" }
  }
  const origin = bindings.names.get(name)
  if (origin === undefined) return { canonical: name, confidence: "high" }
  const canonical = origin.imported === DEFAULT_EXPORT_NAME ? name : origin.imported
  return { canonical, confidence: origin.fromNestjs ? "high" : "medium" }
}

/** The only segment of a receiver that can name a binding. */
function headSegment(qualifier: string): string {
  const dot = qualifier.indexOf(".")
  return dot === -1 ? qualifier : qualifier.slice(0, dot)
}

/** The segment after the head, the member a namespace receiver reads from its module, if any. */
function memberSegment(qualifier: string): string | undefined {
  return qualifier.split(".")[1]
}
