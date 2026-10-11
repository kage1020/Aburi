import { basename } from "node:path"
import type { Component, ComponentId } from "@aburi/types"
import { groupBy } from "./collections"
import type { ManifestIdentity } from "./component-manifest"
import { CoreError } from "./errors"
import { sha256Hex } from "./fingerprint/hash"
import { makeComponentId } from "./id"

export interface CandidateRoot {
  readonly relativeRoot: string
  readonly absoluteRoot: string
}

export function decideId(entry: CandidateRoot, declaredNames: readonly string[]): ComponentId {
  for (const declared of declaredNames) {
    const fromManifest = toIdFromNpmName(declared)
    if (fromManifest !== null) {
      return componentIdOrThrow(fromManifest, `package name "${declared}"`, entry.relativeRoot)
    }
  }
  const leaf = directoryLeaf(entry)
  return componentIdOrThrow(toKebabCase(leaf), `directory name "${leaf}"`, entry.relativeRoot)
}

function componentIdOrThrow(candidate: string, origin: string, root: string): ComponentId {
  try {
    return makeComponentId(candidate)
  } catch (cause) {
    throw new CoreError(
      `Cannot derive a Component id from ${origin} at "${root}": kebab-casing it yields ` +
        `"${candidate}", which is not ASCII kebab-case. Rename it, or ` +
        `declare the component explicitly under components[] in aburi.json.`,
      { code: "invalid-component-id", value: candidate },
      { cause },
    )
  }
}

export function decideName(entry: CandidateRoot, declaredNames: readonly string[]): string {
  return declaredNames[0] ?? directoryLeaf(entry)
}

export function declaredNames(manifests: readonly (ManifestIdentity | null)[]): string[] {
  const names: string[] = []
  for (const manifest of manifests) {
    const name = manifest?.name
    if (typeof name === "string" && name.length > 0) names.push(name)
  }
  return names
}

function directoryLeaf(entry: CandidateRoot): string {
  const segments = entry.relativeRoot.split("/").filter((s) => s.length > 0 && s !== ".")
  return segments[segments.length - 1] ?? basename(entry.absoluteRoot)
}

export function toIdFromNpmName(npmName: string): string | null {
  if (npmName.length === 0) return null
  if (!npmName.startsWith("@")) return toKebabCase(npmName)
  const slash = npmName.indexOf("/")
  if (slash < 0) return null
  const bare = npmName.slice(slash + 1)
  if (bare.length === 0) return null
  const kebabBare = toKebabCase(bare)
  if (kebabBare.length === 0) return ""
  return toKebabCase(`${npmName.slice(1, slash)}-${kebabBare}`)
}

export function toKebabCase(input: string): string {
  return input
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function resolveIdCollisions(components: Component[]): Component[] {
  applyAncestorSuffixPass(components)
  applyRootHashPass(components)
  assertIdsUnique(components)
  return components
}

const ROOT_HASH_LENGTH = 8

interface IdCandidate {
  readonly component: Component
  readonly base: ComponentId
  readonly ancestors: readonly string[]
  consumedAncestors: number
}

function applyAncestorSuffixPass(components: Component[]): void {
  const candidates: IdCandidate[] = components.map((component) => ({
    component,
    base: component.id,
    ancestors: ancestorSegments(component.roots[0] ?? ""),
    consumedAncestors: 0,
  }))
  for (;;) {
    let extended = false
    for (const group of groupBy(candidates, (candidate) => candidate.component.id).values()) {
      if (group.length <= 1) continue
      for (const candidate of group) {
        if (candidate.consumedAncestors >= candidate.ancestors.length) continue
        candidate.consumedAncestors++
        extended = true
      }
    }
    if (!extended) return
    for (const candidate of candidates) {
      candidate.component.id = suffixedId(
        candidate.base,
        candidate.ancestors,
        candidate.consumedAncestors,
      )
    }
  }
}

function applyRootHashPass(components: Component[]): void {
  for (const group of groupBy(components, (component) => component.id).values()) {
    if (group.length <= 1) continue
    for (const component of group) {
      component.id = hashedId(component.id, component.roots[0] ?? "")
    }
  }
}

function assertIdsUnique(components: readonly Component[]): void {
  for (const [id, group] of groupBy(components, (component) => component.id)) {
    if (group.length <= 1) continue
    const roots = group.map((component) => component.roots[0] ?? "?").join(", ")
    throw new CoreError(
      `Component id "${id}" is claimed by more than one component (${roots}) and collision ` +
        `resolution could not separate them. Declare these components explicitly under ` +
        `components[] in aburi.json.`,
      { code: "component-id-collision-unresolved", value: id },
    )
  }
}

/** Nearest first. */
function ancestorSegments(root: string): string[] {
  const segments = root.split("/").filter((s) => s.length > 0 && s !== ".")
  return segments.slice(0, -1).reverse()
}

function suffixedId(
  base: ComponentId,
  ancestors: readonly string[],
  consumed: number,
): ComponentId {
  const suffix = ancestors
    .slice(0, consumed)
    .map(toKebabCase)
    .filter((segment) => segment.length > 0)
  return suffix.length === 0 ? base : makeComponentId(`${base}-${suffix.join("-")}`)
}

function hashedId(id: ComponentId, root: string): ComponentId {
  return makeComponentId(`${id}-${sha256Hex(root).slice(0, ROOT_HASH_LENGTH)}`)
}
