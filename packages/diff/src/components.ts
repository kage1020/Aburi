import type { Component, ComponentDiff, Dependency, DependencyDiff } from "@aburi/types"

/**
 * §6.1 — Component diff. Component identity is `id`; when a Component is present in both
 * base and head with the same id, the three delta booleans describe which axes actually
 * moved (roots reshuffle, public API globs, or framework hint list). `modified` deltas
 * are intentionally absent from this diff (§5.2.3): fields are reported as before/after
 * pairs via the `changed[]` entries so consumers can render them without stringifying
 * arrays.
 */
export function diffComponents(
  base: readonly Component[],
  head: readonly Component[],
): ComponentDiff {
  const baseById = new Map<string, Component>()
  for (const c of base) baseById.set(c.id, c)
  const headById = new Map<string, Component>()
  for (const c of head) headById.set(c.id, c)

  const added: Component[] = []
  const removed: Component[] = []
  const changed: ComponentDiff["changed"] = []

  for (const [id, headComp] of headById) {
    const baseComp = baseById.get(id)
    if (baseComp === undefined) {
      added.push(headComp)
      continue
    }
    const rootsChanged = !stringArraysEqual(baseComp.roots, headComp.roots)
    const publicApiChanged = !stringArraysEqual(baseComp.publicApi ?? [], headComp.publicApi ?? [])
    const frameworksChanged = !stringArraysEqual(
      baseComp.frameworks ?? [],
      headComp.frameworks ?? [],
    )
    if (rootsChanged || publicApiChanged || frameworksChanged) {
      changed.push({
        before: baseComp,
        after: headComp,
        delta: { rootsChanged, publicApiChanged, frameworksChanged },
      })
    }
  }
  for (const [id, baseComp] of baseById) {
    if (!headById.has(id)) removed.push(baseComp)
  }
  sortById(added)
  sortById(removed)
  changed.sort((a, b) => (a.after.id < b.after.id ? -1 : a.after.id > b.after.id ? 1 : 0))
  return { added, removed, changed }
}

/**
 * §6.2 — Dependency diff. Identity is the composite `(from, to, via)` triple; direction
 * and effect changes are surfaced as an added + removed pair so `modified` is not part of
 * the schema (§6.2 tail).
 */
export function diffDependencies(
  base: readonly Dependency[],
  head: readonly Dependency[],
): DependencyDiff {
  const baseKeys = new Map<string, Dependency>()
  for (const d of base) baseKeys.set(dependencyKey(d), d)
  const headKeys = new Map<string, Dependency>()
  for (const d of head) headKeys.set(dependencyKey(d), d)
  const added: Dependency[] = []
  const removed: Dependency[] = []
  for (const [key, dep] of headKeys) {
    const b = baseKeys.get(key)
    if (b === undefined) {
      added.push(dep)
      continue
    }
    if (b.direction !== dep.direction || (b.effect ?? null) !== (dep.effect ?? null)) {
      removed.push(b)
      added.push(dep)
    }
  }
  for (const [key, dep] of baseKeys) {
    if (!headKeys.has(key)) removed.push(dep)
  }
  added.sort(compareDependencies)
  removed.sort(compareDependencies)
  return { added, removed }
}

function dependencyKey(d: Dependency): string {
  return `${d.from}::${d.to}::${d.via}`
}

function compareDependencies(a: Dependency, b: Dependency): number {
  const keyA = dependencyKey(a)
  const keyB = dependencyKey(b)
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sortById<T extends { id: string }>(items: T[]): void {
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
