import { splitAliasedImportName } from "@aburi/core"
import {
  assertImportBinding,
  assertImportEdgeSource,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { Confidence, ImportEdge } from "@aburi/types"
import { FRAMEWORK_NESTJS_PLUGIN_NAME } from "./manifest"

/**
 * Provenance is tested against the scope, not a package list, because the vocabulary spans
 * several packages. The trailing slash keeps `@nestjsx/common` from reading as NestJS.
 */
const NESTJS_SCOPE = "@nestjs/"

/** True when `source` names a package inside the NestJS npm scope. */
export function isNestjsModule(source: string): boolean {
  return source.startsWith(NESTJS_SCOPE)
}

/** What the file's imports say about one written identifier. */
interface NameOrigin {
  /** The name the source module exports it under — the key the decorator tables use. */
  imported: string
  fromNestjs: boolean
}

/** Written identifier → origin. A name the edges never mention is absent, unlike one attributed to a foreign module. */
export type ImportedNames = ReadonlyMap<string, NameOrigin>

/**
 * Index the file's import edges by the local name each binds. The whole list is validated
 * up front, so whether this throws never depends on which entries a lookup reaches.
 *
 * A namespace edge (`symbols: "*"`) contributes nothing: `@nest.Controller()` arrives as the
 * leaf `Controller` with no qualifier on `Decorator`, so it resolves as unbound (and a
 * namespace import from a competing library is thereby trusted further than a named one).
 * Re-export edges count as evidence too; their aliased form arrives as the source-side name
 * only, and nothing on `ImportEdge` tells the two kinds apart.
 *
 * Duplicate bindings (reachable only through re-exports, since a double local binding is a
 * `TS2300`): a NestJS edge beats a non-NestJS one in either order; anything else is settled
 * by write order, an arbitrary tiebreak.
 */
export function readImportedNames(imports: readonly ImportEdge[], filePath: string): ImportedNames {
  const origin: PluginInputOrigin = { plugin: FRAMEWORK_NESTJS_PLUGIN_NAME, filePath }
  const names = new Map<string, NameOrigin>()

  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    if (edge.symbols === "*") continue
    const fromNestjs = isNestjsModule(edge.source)
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      if (names.get(binding.local)?.fromNestjs === true) continue
      names.set(binding.local, { imported: binding.imported, fromNestjs })
    }
  }

  return names
}

export interface ResolvedDecoratorName {
  /** What the decorator tables are matched against. */
  canonical: string
  confidence: Confidence
}

/**
 * Three tiers: imported from `@nestjs/*` → exported name, `high`; imported from anywhere
 * else → exported name, `medium` (a monorepo re-exporting `@nestjs/common` through a path
 * alias is indistinguishable from a foreign package, and refusing would strip every
 * controller's boundary); not mentioned by any edge (namespace import, or no imports) →
 * written name, `high`.
 */
export function resolveDecoratorName(written: string, names: ImportedNames): ResolvedDecoratorName {
  const origin = names.get(written)
  if (origin === undefined) return { canonical: written, confidence: "high" }
  return { canonical: origin.imported, confidence: origin.fromNestjs ? "high" : "medium" }
}
