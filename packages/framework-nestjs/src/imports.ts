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

/**
 * What the file's imports bind, read once per file.
 *
 * `names` answers for a decorator written as a bare identifier, `namespaces` for one written
 * through a receiver. They are separate maps because the two cannot be confused: a local
 * name and a namespace object live in the same scope but a decorator says which of the two
 * it went through, and a file may well bind `Controller` from one module while calling
 * `nest.Controller()` from another.
 */
export interface ImportedBindings {
  /** Written identifier → origin. A name the edges never mention is absent, unlike one attributed to a foreign module. */
  names: ReadonlyMap<string, NameOrigin>
  /** Local name of a namespace import → whether the module it names is NestJS. */
  namespaces: ReadonlyMap<string, boolean>
}

/**
 * Index the file's import edges by what each binds. The whole list is validated up front, so
 * whether this throws never depends on which entries a lookup reaches.
 *
 * A namespace edge (`symbols: "*"`) binds no individual name, so it contributes nothing to
 * `names`; what it does bind is the module object, under `namespaceBinding`, and that is
 * what ties `@nest.Controller()` back to `@nestjs/common` through `Decorator.qualifier`.
 * An edge with no `namespaceBinding` — a bare side-effect import, a wildcard re-export —
 * binds nothing in scope and contributes to neither map.
 *
 * Re-export edges count as evidence too; their aliased form arrives as the source-side name
 * only, and nothing on `ImportEdge` tells the two kinds apart.
 *
 * Duplicate bindings (reachable only through re-exports, since a double local binding is a
 * `TS2300`): a NestJS edge beats a non-NestJS one in either order; anything else is settled
 * by write order, an arbitrary tiebreak. Namespaces are settled the same way.
 */
export function readImportedNames(
  imports: readonly ImportEdge[],
  filePath: string,
): ImportedBindings {
  const origin: PluginInputOrigin = { plugin: FRAMEWORK_NESTJS_PLUGIN_NAME, filePath }
  const names = new Map<string, NameOrigin>()
  const namespaces = new Map<string, boolean>()

  for (const edge of imports) {
    assertImportEdgeSource(edge, origin)
    const fromNestjs = isNestjsModule(edge.source)
    if (edge.symbols === "*") {
      const binding = edge.namespaceBinding
      if (binding === undefined || binding.length === 0) continue
      if (namespaces.get(binding) === true) continue
      namespaces.set(binding, fromNestjs)
      continue
    }
    for (const raw of edge.symbols) {
      const binding = splitAliasedImportName(raw)
      assertImportBinding(binding, raw, edge, origin)
      if (names.get(binding.local)?.fromNestjs === true) continue
      names.set(binding.local, { imported: binding.imported, fromNestjs })
    }
  }

  return { names, namespaces }
}

export interface ResolvedDecoratorName {
  /** What the decorator tables are matched against. */
  canonical: string
  confidence: Confidence
}

/**
 * How much a decorator's written spelling is worth, in the same three tiers whichever form
 * it was written in: bound to `@nestjs/*` → `high`; bound to anywhere else → `medium` (a
 * monorepo re-exporting `@nestjs/common` through a path alias is indistinguishable from a
 * foreign package, and refusing would strip every controller's boundary); bound to nothing
 * the file's edges mention → `high` on the written name, since a file with no imports at all
 * is the ordinary case for a fixture or a partial scan.
 *
 * A **qualified** decorator (`@nest.Controller()`, `Decorator.qualifier` present) is resolved
 * through its receiver and never through `names`: the leaf is a property of the module
 * object, not a binding in the file, so a `Controller` imported by name from somewhere else
 * says nothing about it. Only the receiver's first segment can name a binding — `a.b` in
 * `@a.b.C()` reaches scope as `a` — and the canonical name is the leaf as written, because a
 * namespace import renames nothing.
 *
 * This is what closes the `@tsed.Controller()` misattribution: with no qualifier to read, a
 * namespace import from a competing library fell into the unbound tier and was trusted
 * further than the same decorator imported by name.
 */
export function resolveDecoratorName(
  written: string,
  qualifier: string | undefined,
  bindings: ImportedBindings,
): ResolvedDecoratorName {
  if (qualifier !== undefined && qualifier.length > 0) {
    const fromNestjs = bindings.namespaces.get(headSegment(qualifier))
    if (fromNestjs === undefined) return { canonical: written, confidence: "high" }
    return { canonical: written, confidence: fromNestjs ? "high" : "medium" }
  }
  const origin = bindings.names.get(written)
  if (origin === undefined) return { canonical: written, confidence: "high" }
  return { canonical: origin.imported, confidence: origin.fromNestjs ? "high" : "medium" }
}

/** `a.b` → `a`; `nest` → `nest`. The only segment of a receiver that can name a binding. */
function headSegment(qualifier: string): string {
  const dot = qualifier.indexOf(".")
  return dot === -1 ? qualifier : qualifier.slice(0, dot)
}
