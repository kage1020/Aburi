import { compareBy, compareCodeUnit, serializeCanonical, stringArraysEqual } from "@aburi/core"
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
 * values come from `symbols[].source.file` — the form `stats.skippedFiles[].path` is written
 * in, and the space `buildDiff` classifies Symbols by. The same form is not always the same
 * name: when git renamed a file between the revisions, each document records it under its own
 * name, and `lostCounterparts` translates between the two. Reading the file out of the id's
 * path segment instead would be a second answer to "which file is this endpoint in" that
 * nothing forces to agree with the first. A Component endpoint is absent from the map, which
 * keeps it out of the reclassification without a special case: an aggregate over roots has no
 * file to lose.
 */
export interface DependencySideView {
  symbolFiles: ReadonlyMap<DependencyEndpoint, RelativePath>
  /** Files this document never analysed, by path, with the reason it gave. */
  lostFiles: ReadonlyMap<RelativePath, SkipReason>
}

/**
 * A git rename map read in both directions (`diff-algorithm.md` §3.5.1). A leftover Symbol, or
 * an edge endpoint, names its file the way its own document does, while the document that may
 * have lost it recorded the same file under the name it had there, so each direction is the
 * translation for one side's question.
 *
 * `headToBase` lists every base path renamed onto a head path, sorted. git renames no two base
 * files onto one path, so a list built from `git diff` never holds more than one; a map handed
 * to `buildDiff` directly can, and which of them answers should not be a property of the order
 * that map happens to list them in.
 *
 * Exported because `DependencySideView` is public and `diffDependencies` requires one. Build it
 * with `renameDirections`, which is what keeps the two directions each other's inverse.
 */
export interface RenameDirections {
  readonly baseToHead: ReadonlyMap<RelativePath, RelativePath>
  readonly headToBase: ReadonlyMap<RelativePath, readonly RelativePath[]>
}

/**
 * Both directions of `renames`, the base-to-head map `git diff --find-renames` gives. `null` —
 * no rename information, as with `--base` / `--head` IR files — gives two empty directions,
 * which is how a caller with nothing to translate says so. Exported for the reason
 * `RenameDirections` is. Copies `renames`, so a later change to the caller's map cannot reach
 * a diff built from it.
 */
export function renameDirections(
  renames: ReadonlyMap<RelativePath, RelativePath> | null,
): RenameDirections {
  const baseToHead = new Map<RelativePath, RelativePath>(renames ?? [])
  const headToBase = new Map<RelativePath, RelativePath[]>()
  for (const [basePath, headPath] of baseToHead) {
    const claimants = headToBase.get(headPath)
    if (claimants === undefined) headToBase.set(headPath, [basePath])
    else claimants.push(basePath)
  }
  for (const claimants of headToBase.values()) claimants.sort(compareCodeUnit)
  return { baseToHead, headToBase }
}

/** The document that lacks an entry, and so the one a loss is looked up in. */
export type AbsentSide = "base" | "head"

/** Everything a loss lookup reads: both side views, and the rename map that joins them. */
export interface LossSides {
  base: DependencySideView
  head: DependencySideView
  renames: RenameDirections
}

/**
 * Every record the `absentFrom` document holds for the file the other document names `path`,
 * each with the path the absent document recorded it under: `path` itself first, then — when
 * git renamed the file between the revisions — each name the rename map gives it on the absent
 * side, in path order. Without the second lookup a renamed file the other side skipped would
 * leave its Symbols as confident additions or deletions, which is the silence `unknown` exists
 * to break.
 *
 * Takes the side by name and picks both the view and the rename direction from it, because each
 * is one of a pair of the same type — `RelativePath` is a plain string — so handing over the
 * wrong one would compile and quietly restore the lookup a rename defeats.
 */
export function lostCounterparts(
  path: RelativePath,
  absentFrom: AbsentSide,
  sides: LossSides,
): DiffSkippedFile[] {
  const absent = sides[absentFrom]
  const found: DiffSkippedFile[] = []
  const reason = absent.lostFiles.get(path)
  if (reason !== undefined) found.push({ path, reason })
  for (const other of namesOnSide(path, absentFrom, sides.renames)) {
    if (other === path) continue
    const otherReason = absent.lostFiles.get(other)
    if (otherReason !== undefined) found.push({ path: other, reason: otherReason })
  }
  return found
}

/**
 * The first of `lostCounterparts`, for an entry that needs one explanation rather than every
 * record: a Symbol carries one `reason`, and an edge endpoint is one file.
 */
export function lostCounterpart(
  path: RelativePath,
  absentFrom: AbsentSide,
  sides: LossSides,
): DiffSkippedFile | undefined {
  return lostCounterparts(path, absentFrom, sides)[0]
}

/** What git renamed the other document's `path` to, or from, on the `absentFrom` side. */
function namesOnSide(
  path: RelativePath,
  absentFrom: AbsentSide,
  renames: RenameDirections,
): readonly RelativePath[] {
  if (absentFrom === "base") return renames.headToBase.get(path) ?? []
  const headPath = renames.baseToHead.get(path)
  return headPath === undefined ? [] : [headPath]
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
 * skip list passes a side view whose `lostFiles` is empty. `renames` is required on the same
 * terms: without it an edge into a file git renamed and one side skipped would be a confident
 * deletion or addition beside the same `unknown: []`. A caller with no rename information
 * passes `renameDirections(null)`.
 *
 * The return type declares `unknown` present, where the schema leaves it optional for
 * documents that predate the field.
 */
export function diffDependencies(
  base: readonly Dependency[],
  head: readonly Dependency[],
  sides: { base: DependencySideView; head: DependencySideView; renames: RenameDirections },
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
      const lostFiles = endpointsLostBy(dep, "base", sides)
      if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "base", lostFiles })
      else added.push(dep)
      continue
    }
    if (baseDep.direction !== dep.direction || (baseDep.effect ?? null) !== (dep.effect ?? null)) {
      removed.push(baseDep)
      added.push(dep)
    }
  }
  for (const [key, dep] of baseKeys) {
    if (headKeys.has(key)) continue
    const lostFiles = endpointsLostBy(dep, "head", sides)
    if (lostFiles.length > 0) unknown.push({ dependency: dep, absentFrom: "head", lostFiles })
    else removed.push(dep)
  }
  added.sort(compareDependencies)
  removed.sort(compareDependencies)
  unknown.sort((a, b) => compareDependencies(a.dependency, b.dependency))
  return { added, removed, unknown }
}

/**
 * The endpoint files the `absentFrom` document never analysed, read through the other one —
 * the holder — because that is the document the edge, and the Symbol behind each endpoint,
 * comes from. Both endpoints are checked: an edge dies when *either* end's file goes. Each path
 * is the one the absent document recorded, which after a git rename is not the holder's.
 * Deduped on that path and sorted by it, so an intra-file edge collapses to the one file it
 * lost, renamed or not.
 */
function endpointsLostBy(
  dep: Dependency,
  absentFrom: AbsentSide,
  sides: LossSides,
): DiffSkippedFile[] {
  const holder = sides[absentFrom === "base" ? "head" : "base"]
  const byPath = new Map<RelativePath, SkipReason>()
  for (const endpoint of [dep.from, dep.to]) {
    const file = holder.symbolFiles.get(endpoint)
    if (file === undefined) continue
    const lost = lostCounterpart(file, absentFrom, sides)
    if (lost === undefined) continue
    byPath.set(lost.path, lost.reason)
  }
  return [...byPath.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .sort(compareBy((file) => file.path))
}

export const DEPENDENCY_IDENTITY_FIELDS = ["from", "to", "via"] as const

export function dependencyIdentity(parts: readonly string[]): string {
  return parts.join("::")
}

function dependencyKey(dependency: Dependency): string {
  return dependencyIdentity(DEPENDENCY_IDENTITY_FIELDS.map((field) => dependency[field]))
}

const compareDependencies = compareBy(dependencyKey)

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
