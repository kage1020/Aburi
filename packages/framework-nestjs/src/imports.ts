import { splitAliasedImportName } from "@aburi/core"
import {
  assertImportBinding,
  assertImportEdgeSource,
  assertNamespaceBinding,
  type PluginInputOrigin,
} from "@aburi/plugin-registry/plugin-input"
import type { Confidence, Decorator, ImportEdge } from "@aburi/types"
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
  readonly imported: string
  /** The module specifier the name came from, kept so a downgrade can say which module caused it. */
  readonly source: string
  readonly fromNestjs: boolean
}

/**
 * What a namespace edge says about the local name it bound.
 *
 * A record rather than the bare `fromNestjs` boolean, for two reasons. It keeps the module
 * specifier, which `readImportedNames` holds and would otherwise throw away, so a `medium`
 * can name the module that caused it. And it is symmetric with `NameOrigin` on a type that
 * is already public, which is what makes the next field non-breaking to add. There is no
 * `imported` here because a namespace import renames nothing.
 */
interface NamespaceOrigin {
  readonly source: string
  readonly fromNestjs: boolean
}

/**
 * What the file's imports bind, read once per file.
 *
 * `names` answers for a decorator written as a bare identifier. A decorator written through
 * a receiver consults `namespaces` first and then `names`, because both can bind the object
 * it went through: `import * as nest` lands in the first, `import nest from` in the second.
 * They stay separate maps because they answer different questions about the same scope —
 * whether a name is the module object, or a single export of some module — and a file may
 * well bind `Controller` by name from one module while writing `nest.Controller()` through
 * another.
 *
 * Both fields are `readonly`: one value is cached per file and shared by every Symbol in it
 * (`classify.ts`), so a single reassignment would reach all of them.
 */
export interface ImportedBindings {
  /** Written identifier → origin. A name the edges never mention is absent, unlike one attributed to a foreign module. */
  readonly names: ReadonlyMap<string, NameOrigin>
  /** Local name a namespace edge bound → what module it names. */
  readonly namespaces: ReadonlyMap<string, NamespaceOrigin>
}

/**
 * Index the file's import edges by what each binds. The whole list is validated up front, so
 * whether this throws never depends on which entries a lookup reaches.
 *
 * A namespace edge (`symbols: "*"`) binds no individual name, so it contributes nothing to
 * `names`; what it does bind is the module object, under `namespaceBinding`, and that is
 * what ties `@nest.Controller()` back to `@nestjs/common` through `Decorator.qualifier`.
 * An edge with no `namespaceBinding` — a bare side-effect import, a wildcard re-export —
 * binds nothing in scope and contributes to neither map, while one whose binding is present
 * but empty is an upstream fault rather than a shape to skip, and throws.
 *
 * A **default** import binds the module object too, and lands in `names` instead: the
 * language plugin reports `import nest from "m"` as `symbols: ["nest"]` with no
 * `namespaceBinding`, which is why a receiver is looked up in both maps (`resolveDecoratorName`).
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

/**
 * How much a decorator's written spelling is worth, in the same three tiers whichever form
 * it was written in: bound to `@nestjs/*` → `high`; bound to anywhere else → `medium` (a
 * monorepo re-exporting `@nestjs/common` through a path alias is indistinguishable from a
 * foreign package, and refusing would strip every controller's boundary); **no edge binds
 * it** → `high` on the written name, since a file with no imports at all is the ordinary
 * case for a fixture or a partial scan.
 *
 * A **qualified** decorator (`@nest.Controller()`) is resolved on its receiver rather than
 * its leaf, and the canonical name is the leaf as written, because a namespace import
 * renames nothing. Only the receiver's first segment can name a binding — `a.b` in
 * `@a.b.C()` reaches scope as `a` — so that segment is what is looked up, and it is looked
 * up in **both** maps: `import * as nest` binds the module object under `namespaces`, while
 * `import nest from` binds it under `names`, and a decorator written through either has
 * disclosed the same thing about where it came from. Reading only one of the two is what
 * left `@tsed.Controller()` in the unbound tier one spelling over.
 *
 * What a qualified decorator must never do is resolve its **leaf** through `names`. The leaf
 * is a property of a module object, not an identifier in the file's scope, so a `Controller`
 * imported by name from somewhere else says nothing about the one written as `nest.Controller`
 * — and reading it would attribute the decorator to a module it was never written through.
 * The receiver is the opposite case: `nest` really is an identifier in scope, and the edge
 * that binds it really does name its module.
 */
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
  return { canonical: origin.imported, confidence: origin.fromNestjs ? "high" : "medium" }
}

/** `a.b` → `a`; `nest` → `nest`. The only segment of a receiver that can name a binding. */
function headSegment(qualifier: string): string {
  const dot = qualifier.indexOf(".")
  return dot === -1 ? qualifier : qualifier.slice(0, dot)
}
