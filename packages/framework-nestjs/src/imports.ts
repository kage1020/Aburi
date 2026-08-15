import { splitAliasedImportName } from "@aburi/core"
import {
  assertImportBinding,
  assertImportEdgeSource,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { Confidence, ImportEdge } from "@aburi/types"
import { FRAMEWORK_NESTJS_PLUGIN_NAME } from "./manifest"

/**
 * The npm scope every NestJS package lives under. Provenance is tested against the scope
 * rather than a package list because the vocabulary is spread across several of them today
 * (`@nestjs/common` for HTTP and DI, `@nestjs/microservices` for `@MessagePattern`,
 * `@nestjs/websockets` for `@SubscribeMessage`) and the list grows. The trailing slash is
 * load-bearing: without it `@nestjsx/common` — a different project — would read as NestJS.
 */
const NESTJS_SCOPE = "@nestjs/"

/** True when `source` names a package inside the NestJS npm scope. */
export function isNestjsModule(source: string): boolean {
  return source.startsWith(NESTJS_SCOPE)
}

/**
 * What the file's imports say about one written identifier.
 *
 * `imported` is the name the source module exports it under — the name the decorator tables
 * are keyed by. `fromNestjs` records whether the module it came from is inside the NestJS
 * scope.
 */
interface NameOrigin {
  imported: string
  fromNestjs: boolean
}

/**
 * Written identifier → what the file's import edges say about it. A name the edges never
 * mention is absent, which is different from a name they attribute to a foreign module.
 */
export type ImportedNames = ReadonlyMap<string, NameOrigin>

/**
 * Index the file's import edges by the local name each one binds.
 *
 * Every edge and every entry is validated, and the whole list is walked, so *whether this
 * throws* never depends on which entries a later lookup happens to reach.
 *
 * A namespace edge (`symbols: "*"`) binds no individually imported name and contributes
 * nothing — the local name it does carry (`namespaceBinding`) is the namespace object, not
 * any of the module's exports. The language plugin hands a qualified decorator over as its
 * leaf identifier (`@nest.Controller()` arrives as `Controller`), and the qualifier that
 * would connect it to the namespace binding is not carried on `Decorator` at all, so such a
 * decorator is resolved as unbound. The cost is that a namespace import from a competing
 * library is trusted further than the named import of the same decorator would be, which is
 * the limit of what the edges can settle here.
 *
 * Re-export edges (`export { X } from './y'`) are in the list too, and for the unaliased
 * form treating them as evidence is the right reading — the question this map answers is
 * what the file says about a name, not what is lexically visible. The aliased form reaches
 * here as its source-side name alone (`export { X as Y }` arrives as `"X"`; the language
 * plugin composes `" as "` on imports but not on re-exports), so the name the file actually
 * publishes is not what gets indexed. Nothing on `ImportEdge` distinguishes the two kinds.
 *
 * Duplicate bindings resolve as follows, and only the first row is order-independent:
 *
 * - **NestJS against non-NestJS** — the NestJS edge wins, in either order.
 * - **anything else** — two foreign edges, or two NestJS edges disagreeing on the exported
 *   name, are settled by write order. No ordering of a duplicate binding is more truthful
 *   than the other, so the tiebreak is arbitrary rather than reasoned.
 *
 * Duplicates are reachable at all only because re-export edges name without binding: a name
 * bound twice in local scope is a `TS2300` the file would not compile with.
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

/**
 * A decorator's written name resolved against the file's imports.
 *
 * `canonical` is what the decorator tables are matched against; `confidence` is how far the
 * resulting classification should be trusted.
 */
export interface ResolvedDecoratorName {
  canonical: string
  confidence: Confidence
}

/**
 * Resolve the identifier a decorator was written with, in three tiers:
 *
 * - **imported from `@nestjs/*`** — the canonical name is whatever the package exports it
 *   as, and the classification is as trustworthy as it was before aliasing existed.
 * - **imported from anywhere else** — same resolution, `medium` confidence. Downgrading
 *   rather than refusing is deliberate: a NestJS monorepo conventionally re-exports
 *   `@nestjs/common` through a tsconfig path alias (`@app/common`), which is
 *   indistinguishable from a foreign package without reading `tsconfig.json`. Refusing
 *   would take the boundary off every controller in such a project — the same loss this
 *   resolution exists to prevent, at a larger scale. The cost is that a `@Controller` from
 *   a competing library still classifies, at `medium` rather than `high`.
 * - **not mentioned by any edge** — nothing to resolve, so the written name is taken as
 *   canonical at full confidence. This is the reading for a decorator reached through a
 *   namespace import, and for a file that declares no imports at all. It is also the one
 *   place the tiers are not ordered by how much the file told us: a namespace import from a
 *   competing library lands here, above the named import of the same decorator.
 */
export function resolveDecoratorName(written: string, names: ImportedNames): ResolvedDecoratorName {
  const origin = names.get(written)
  if (origin === undefined) return { canonical: written, confidence: "high" }
  return { canonical: origin.imported, confidence: origin.fromNestjs ? "high" : "medium" }
}
