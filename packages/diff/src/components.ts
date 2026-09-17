import { compareBy, serializeCanonical, stringArraysEqual } from "@aburi/core"
import type {
  Component,
  ComponentDiff,
  ComponentId,
  Dependency,
  DependencyDiff,
  DependencyEndpoint,
  DependencyUnknown,
  DiffSkippedFile,
  IR,
  RelativePath,
  SkipReason,
} from "@aburi/types"
import { DiffError } from "./errors"

const byId = compareBy((item: { id: string }) => item.id)

/**
 * `docs/design/diff-algorithm.md` — Component diff. Assumes `components[].id` is unique
 * on each side (ir-schema.md #2) and does not check it: `buildDiff` establishes that, and
 * a caller reaching this export directly owns the obligation, because the lookup map here is
 * last-write-wins.
 *
 * Any field that differs makes a Component `changed` — the whole object is compared, not the
 * three axes the delta names, so a `changed[]` entry with all three booleans `false` is a
 * well-formed answer meaning "something else about this component moved". `modified` deltas
 * are intentionally absent: fields are reported as before/after pairs.
 */
export function diffComponents(
  base: readonly Component[],
  head: readonly Component[],
): ComponentDiff {
  const baseById = new Map<ComponentId, Component>()
  for (const component of base) baseById.set(component.id, component)
  const headById = new Map<ComponentId, Component>()
  for (const component of head) headById.set(component.id, component)

  const added: Component[] = []
  const removed: Component[] = []
  const changed: ComponentDiff["changed"] = []

  for (const [id, headComp] of headById) {
    const baseComp = baseById.get(id)
    if (baseComp === undefined) {
      added.push(headComp)
      continue
    }
    if (!componentsEqual(baseComp, headComp)) {
      changed.push({
        before: baseComp,
        after: headComp,
        delta: {
          rootsChanged: !stringArraysEqual(baseComp.roots, headComp.roots),
          publicApiChanged: !stringArraysEqual(baseComp.publicApi ?? [], headComp.publicApi ?? []),
          frameworksChanged: !stringArraysEqual(
            baseComp.frameworks ?? [],
            headComp.frameworks ?? [],
          ),
        },
      })
    }
  }
  for (const [id, baseComp] of baseById) {
    if (!headById.has(id)) removed.push(baseComp)
  }
  added.sort(byId)
  removed.sort(byId)
  changed.sort(compareBy((entry) => entry.after.id))
  return { added, removed, changed }
}

/**
 * What one document knows about itself, for deciding whether the *other* document's silence
 * about an edge is evidence.
 *
 * `symbolFiles` is keyed on the endpoint id exactly as `dependencies[]` spells it, and its
 * values come from `symbols[].source.file` — the same space `stats.skippedFiles[].path` is in,
 * and the same space `buildDiff` classifies Symbols by. Reading the file out of the id's path
 * segment instead would be a second answer to "which file is this endpoint in" that nothing
 * forces to agree with the first. A Component endpoint is absent from the map, which keeps it
 * out of the reclassification without a special case: an aggregate over roots has no file to
 * lose.
 */
export interface DependencySideView {
  /**
   * `source.file` of every Symbol this document holds, keyed by `DependencyEndpoint` rather
   * than `SymbolId` because the lookup happens with an endpoint whose kind is not yet known,
   * and "absent" is the answer for a Component id.
   */
  symbolFiles: ReadonlyMap<DependencyEndpoint, RelativePath>
  /** Files this document never analysed, by path, with the reason it gave. */
  lostFiles: ReadonlyMap<RelativePath, SkipReason>
}

/**
 * Build a side view from a document. Exported because `DependencySideView` is public and
 * `diffDependencies` requires one; `buildDiff` reads `lostFiles` for its own Symbol
 * classification from this same object.
 */
export function dependencySideView(ir: IR): DependencySideView {
  const symbolFiles = new Map<DependencyEndpoint, RelativePath>()
  for (const symbol of ir.symbols) symbolFiles.set(symbol.id, symbol.source.file)
  const lostFiles = new Map<RelativePath, SkipReason>()
  for (const file of ir.stats.skippedFiles ?? []) lostFiles.set(file.path, file.reason)
  return { symbolFiles, lostFiles }
}

/**
 * `docs/design/diff-algorithm.md` — Dependency diff. Identity is the composite
 * `(from, to, via)` triple; direction and effect changes surface as an added + removed pair so
 * `modified` is not part of the schema. Uniqueness of the triple is the caller's
 * obligation on the same terms as `diffComponents`.
 *
 * `sides` separates a deletion from a loss and is required rather than optional:
 * omitting it would silently classify every edge into a lost file as a deletion while still
 * writing `unknown: []`, which the schema defines as "nothing was unknown". A caller with no
 * skip list passes a side view whose `lostFiles` is empty.
 *
 * The return type declares `unknown` present, where the schema leaves it optional for
 * documents that predate the field.
 */
export function diffDependencies(
  base: readonly Dependency[],
  head: readonly Dependency[],
  sides: { base: DependencySideView; head: DependencySideView },
): DependencyDiff & { unknown: DependencyUnknown[] } {
  const baseKeys = new Map<string, Dependency>()
  for (const dependency of base) baseKeys.set(dependencyKey(dependency), dependency)
  const headKeys = new Map<string, Dependency>()
  for (const dependency of head) headKeys.set(dependencyKey(dependency), dependency)
  const added: Dependency[] = []
  const removed: Dependency[] = []
  const unknown: DependencyUnknown[] = []
  for (const [key, dep] of headKeys) {
    const baseDep = baseKeys.get(key)
    if (baseDep === undefined) {
      // Held by head and not by base, so its endpoints resolve against head — the document
      // that has the Symbols — and the question is whether base could have seen them.
      const lostFiles = endpointsLostBy(dep, sides.head, sides.base)
      if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "base", lostFiles })
      else added.push(dep)
      continue
    }
    // A direction or effect flip. No loss check: both documents hold the edge, so neither is
    // silent about it, and `unknown` exists only to explain a silence.
    if (baseDep.direction !== dep.direction || (baseDep.effect ?? null) !== (dep.effect ?? null)) {
      removed.push(baseDep)
      added.push(dep)
    }
  }
  for (const [key, dep] of baseKeys) {
    if (headKeys.has(key)) continue
    const lostFiles = endpointsLostBy(dep, sides.base, sides.head)
    if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "head", lostFiles })
    else removed.push(dep)
  }
  added.sort(compareDependencies)
  removed.sort(compareDependencies)
  unknown.sort((a, b) => compareDependencies(a.dependency, b.dependency))
  return { added, removed, unknown }
}

/**
 * The endpoint files `absent` never analysed, read through `holder` because that is the
 * document the edge — and the Symbol behind each endpoint — comes from. Both endpoints are
 * checked: an edge dies when *either* end's file goes. Deduped and sorted by path, so an
 * intra-file edge collapses to the one file it lost.
 */
function endpointsLostBy(
  dep: Dependency,
  holder: DependencySideView,
  absent: DependencySideView,
): DiffSkippedFile[] {
  const byPath = new Map<RelativePath, SkipReason>()
  for (const endpoint of [dep.from, dep.to]) {
    const file = holder.symbolFiles.get(endpoint)
    // Normally a Component endpoint, which has no file to lose. A symbol-shaped endpoint with
    // no Symbol behind it (forbidden by ir-schema.md #4, but `buildDiff` runs no integrity
    // check) lands here too and quietly reverts to the plain classification: there is no
    // diagnostics channel, and refusing would take down the legitimate case sharing the branch.
    if (file === undefined) continue
    const reason = absent.lostFiles.get(file)
    if (reason === undefined) continue
    byPath.set(file, reason)
  }
  return [...byPath.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .sort(compareBy((file) => file.path))
}

/**
 * `docs/design/diff-algorithm.md` — the fields Dependency identity is made of, in key
 * order, and the join that turns them into one. Both exported so the entry-point uniqueness
 * check keys on exactly what this file keys on. Core's invariant #13 joins the same triple
 * with a different separator; the two agree for every endpoint that satisfies the id grammars
 * of ir-schema.md.
 */
export const DEPENDENCY_IDENTITY_FIELDS = ["from", "to", "via"] as const

export function dependencyIdentity(parts: readonly string[]): string {
  return parts.join("::")
}

function dependencyKey(dependency: Dependency): string {
  return dependencyIdentity(DEPENDENCY_IDENTITY_FIELDS.map((field) => dependency[field]))
}

const compareDependencies = compareBy(dependencyKey)

/**
 * Whether two Components are the same record over every field the document carries, via
 * `@aburi/core`'s canonical serialization of the normalized form — so a field added to `v1`
 * later is compared without a list here going stale, and key order or Unicode spelling
 * cannot manufacture a change. The serializer's refusals (`non-plain-json`,
 * `canonical-key-collision`) become `DiffError`, because `errors.ts` is the whole of this
 * package's failure surface.
 */
function componentsEqual(a: Component, b: Component): boolean {
  return canonicalComponent(a, "base") === canonicalComponent(b, "head")
}

function canonicalComponent(component: Component, side: "base" | "head"): string {
  try {
    return serializeCanonical(normalizeComponent(component), { format: "compact" })
  } catch (error) {
    throw new DiffError(
      `${side} components[id=${component.id}] cannot be compared: ${error instanceof Error ? error.message : String(error)}`,
      { code: "ir-shape-invalid", value: `components[id=${component.id}]` },
      { cause: error },
    )
  }
}

/**
 * The spelling-independent form of a Component (ir-schema.md): `description` is Class A,
 * so absent and `null` are one spelling; `publicApi` and `frameworks` are Class B fields whose
 * own writer rule is "omitted when empty", so absent and `[]` are one spelling. Class B does
 * not say that in general — a field whose presence is itself information must not be added
 * to `PRESENCE_EQUALS_EMPTY_FIELDS`.
 */
function normalizeComponent(component: Component): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...component }
  if (normalized.description === null || normalized.description === undefined) {
    delete normalized.description
  }
  for (const field of PRESENCE_EQUALS_EMPTY_FIELDS) {
    const value = normalized[field]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete normalized[field]
    }
  }
  return normalized
}

const PRESENCE_EQUALS_EMPTY_FIELDS = ["publicApi", "frameworks"] as const
