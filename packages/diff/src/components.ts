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

export interface DependencySideView {
  symbolFiles: ReadonlyMap<DependencyEndpoint, RelativePath>
  lostFiles: ReadonlyMap<RelativePath, SkipReason>
}

export interface RenameDirections {
  readonly baseToHead: ReadonlyMap<RelativePath, RelativePath>
  readonly headToBase: ReadonlyMap<RelativePath, readonly RelativePath[]>
}

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

export type AbsentSide = "base" | "head"

export interface LossSides {
  base: DependencySideView
  head: DependencySideView
  renames: RenameDirections
}

export function lostCounterparts(
  path: RelativePath,
  absentFrom: AbsentSide,
  sides: LossSides,
): DiffSkippedFile[] {
  const absent = sides[absentFrom]
  const found: DiffSkippedFile[] = []
  const reason = absent.lostFiles.get(path)
  if (reason !== undefined) found.push({ path, reason })
  for (const other of renamedOnAbsentSide(path, absentFrom, sides.renames)) {
    if (other === path) continue
    const otherReason = absent.lostFiles.get(other)
    if (otherReason !== undefined) found.push({ path: other, reason: otherReason })
  }
  return found
}

export function lostCounterpart(
  path: RelativePath,
  absentFrom: AbsentSide,
  sides: LossSides,
): DiffSkippedFile | undefined {
  return lostCounterparts(path, absentFrom, sides)[0]
}

function renamedOnAbsentSide(
  path: RelativePath,
  absentFrom: AbsentSide,
  renames: RenameDirections,
): readonly RelativePath[] {
  if (absentFrom === "base") return renames.headToBase.get(path) ?? []
  const headPath = renames.baseToHead.get(path)
  return headPath === undefined ? [] : [headPath]
}

export function dependencySideView(ir: IR): DependencySideView {
  const symbolFiles = new Map<DependencyEndpoint, RelativePath>()
  for (const symbol of ir.symbols) symbolFiles.set(symbol.id, symbol.source.file)
  const lostFiles = new Map<RelativePath, SkipReason>()
  for (const file of ir.stats.skippedFiles ?? []) lostFiles.set(file.path, file.reason)
  return { symbolFiles, lostFiles }
}

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
