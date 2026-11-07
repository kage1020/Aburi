import { basename } from "node:path"
import type { Component, ComponentId, LanguageId } from "@aburi/types"
import {
  type CandidateRoot,
  decideId,
  decideName,
  declaredNames,
  resolveIdCollisions,
  toIdFromNpmName,
  toKebabCase,
} from "./component-id"
import { countLanguagesPerRoot } from "./component-languages"
import {
  collectFrameworks,
  collectPublicApi,
  type IgnoredPublicApiValue,
  NPM_MANIFEST,
  type NpmManifest,
  readCandidateManifests,
} from "./component-manifest"
import { makeLanguageId } from "./id"
import { compareBy } from "./order"
import { type DetectManagersOptions, detectManagers, type WorkspaceCandidate } from "./workspace"

const FALLBACK_LANGUAGE: LanguageId = makeLanguageId("ts")

export interface DetectComponentsOptions extends DetectManagersOptions {
  /** Absolute. */
  workspaceRoot: string
  ignore?: readonly string[]
}

/** A `package.json` value of a detected Component that gave its `publicApi` no entry. */
export interface IgnoredPublicApi extends IgnoredPublicApiValue {
  component: ComponentId
  /** Workspace-relative. */
  manifestPath: string
}

export interface DetectComponentsResult {
  components: Component[]
  /** By component id, then in the order the manifest holds them. */
  ignoredPublicApi: IgnoredPublicApi[]
}

export async function detectComponents(
  options: DetectComponentsOptions,
): Promise<DetectComponentsResult> {
  const { workspaces } = await detectManagers(options.workspaceRoot, {
    respectGitignore: options.respectGitignore,
  })
  const mergedCandidates =
    workspaces.length === 0
      ? [rootCandidate(options.workspaceRoot)]
      : mergeCandidatesByPath(workspaces)
  const languages = await countLanguagesPerRoot(
    options.workspaceRoot,
    mergedCandidates.map((entry) => entry.relativeRoot),
    options,
  )
  const built = await Promise.all(
    mergedCandidates.map((entry) => buildComponent(entry, languages.get(entry.relativeRoot) ?? [])),
  )
  // Collision resolution renames in place, so each ignored value is labelled after it.
  const components = resolveIdCollisions(built.map(({ component }) => component)).sort(
    compareBy((component) => component.id),
  )
  const ignoredPublicApi = built
    .flatMap(({ component, root, ignored }) =>
      ignored.map((value) => ({
        component: component.id,
        manifestPath: root === "." ? NPM_MANIFEST : `${root}/${NPM_MANIFEST}`,
        ...value,
      })),
    )
    .sort(compareBy((value) => value.component))
  return { components, ignoredPublicApi }
}

interface MergedCandidate extends CandidateRoot {
  manifests: Map<string, string>
}

function rootCandidate(workspaceRoot: string): MergedCandidate {
  return { relativeRoot: ".", absoluteRoot: workspaceRoot, manifests: new Map() }
}

function mergeCandidatesByPath(candidates: readonly WorkspaceCandidate[]): MergedCandidate[] {
  const byPath = new Map<string, MergedCandidate>()
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.relativeRoot)
    if (existing === undefined) {
      byPath.set(candidate.relativeRoot, {
        relativeRoot: candidate.relativeRoot,
        absoluteRoot: candidate.absoluteRoot,
        manifests: new Map([[basename(candidate.manifestPath), candidate.manifestPath]]),
      })
      continue
    }
    existing.manifests.set(basename(candidate.manifestPath), candidate.manifestPath)
  }
  return [...byPath.values()]
}

interface BuiltComponent {
  component: Component
  root: string
  ignored: IgnoredPublicApiValue[]
}

async function buildComponent(
  entry: MergedCandidate,
  languages: readonly LanguageId[],
): Promise<BuiltComponent> {
  const manifests = await readCandidateManifests(entry)
  // The one place a parse is read as an `NpmManifest`: it came from the `package.json` slot.
  const npmManifest: NpmManifest | null =
    manifests.find((read) => read.kind === NPM_MANIFEST)?.manifest ?? null
  const declared = declaredNames(manifests.map((read) => read.manifest))
  const id = decideId(entry, declared)
  const name = decideName(entry, declared)
  const frameworks = collectFrameworks(npmManifest)
  const publicApi = collectPublicApi(npmManifest, entry.relativeRoot)
  const component: Component = {
    id,
    name,
    roots: [entry.relativeRoot],
    languages: languages.length > 0 ? [...languages] : [FALLBACK_LANGUAGE],
    description: null,
  }
  if (publicApi.entries.length > 0) component.publicApi = publicApi.entries
  if (frameworks.length > 0) component.frameworks = frameworks
  return { component, root: entry.relativeRoot, ignored: publicApi.ignored }
}

export const __testing = {
  toIdFromNpmName,
  toKebabCase,
  collectFrameworks,
  collectPublicApi,
  resolveIdCollisions,
}
