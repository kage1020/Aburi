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

/** True when `source` names a package inside the NestJS npm scope. */
export function isNestjsModule(source: string): boolean {
  return source.startsWith(NESTJS_SCOPE)
}

/** What the file's imports say about one written identifier. */
interface NameOrigin {
  readonly imported: string
  /** The module specifier the name came from, kept so a downgrade can say which module caused it. */
  readonly source: string
  readonly fromNestjs: boolean
}

interface NamespaceOrigin {
  readonly source: string
  readonly fromNestjs: boolean
}

export interface ImportedBindings {
  /** Written identifier → origin. A name the edges never mention is absent, unlike one attributed to a foreign module. */
  readonly names: ReadonlyMap<string, NameOrigin>
  /** Local name a namespace edge bound → what module it names. */
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
    const fromNestjs = isNestjsModule(edge.source)
    if (edge.symbols === "*") {
      const binding = edge.namespaceBinding
      if (binding === undefined) continue
      assertNamespaceBinding(binding, edge, origin)
      if (namespaces.get(binding)?.fromNestjs === true) continue
      namespaces.set(binding, { source: edge.source, fromNestjs })
      continue
    }
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      if (names.get(binding.local)?.fromNestjs === true) continue
      names.set(binding.local, { imported: binding.imported, source: edge.source, fromNestjs })
    }
  }

  return { names, namespaces }
}

export interface ResolvedDecoratorName {
  /** What the decorator tables are matched against. */
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
      return { canonical: name, confidence: viaNamespace.fromNestjs ? "high" : "medium" }
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

/** `a.b` → `a`; `nest` → `nest`. The only segment of a receiver that can name a binding. */
function headSegment(qualifier: string): string {
  const dot = qualifier.indexOf(".")
  return dot === -1 ? qualifier : qualifier.slice(0, dot)
}
