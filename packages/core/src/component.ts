import { basename } from "node:path"
import type { Component, LanguageId } from "@aburi/types"
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
  NPM_MANIFEST,
  type NpmManifest,
  readCandidateManifests,
} from "./component-manifest"
import { makeLanguageId } from "./id"
import { compareBy } from "./order"
import { detectManagers, type WorkspaceCandidate } from "./workspace"

const FALLBACK_LANGUAGE: LanguageId = makeLanguageId("ts")

export interface DetectComponentsOptions {
  /** Absolute. */
  workspaceRoot: string
  ignore?: readonly string[]
  respectGitignore?: boolean
}

export async function detectComponents(options: DetectComponentsOptions): Promise<Component[]> {
  const { workspaces } = await detectManagers(options.workspaceRoot)
  const mergedCandidates =
    workspaces.length === 0
      ? [rootCandidate(options.workspaceRoot)]
      : mergeCandidatesByPath(workspaces)
  const languages = await countLanguagesPerRoot(
    options.workspaceRoot,
    mergedCandidates.map((entry) => entry.relativeRoot),
    options,
  )
  const components = await Promise.all(
    mergedCandidates.map((entry) => buildComponent(entry, languages.get(entry.relativeRoot) ?? [])),
  )
  return resolveIdCollisions(components).sort(compareBy((component) => component.id))
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

async function buildComponent(
  entry: MergedCandidate,
  languages: readonly LanguageId[],
): Promise<Component> {
  const manifests = await readCandidateManifests(entry)
  // The one place a parse is read as an `NpmManifest`: it came from the `package.json` slot.
  const npmManifest: NpmManifest | null =
    manifests.find((read) => read.kind === NPM_MANIFEST)?.manifest ?? null
  const declared = declaredNames(manifests.map((read) => read.manifest))
  const id = decideId(entry, declared)
  const name = decideName(entry, declared)
  const frameworks = collectFrameworks(npmManifest)
  const publicApi = collectPublicApi(npmManifest)
  const component: Component = {
    id,
    name,
    roots: [entry.relativeRoot],
    languages: languages.length > 0 ? [...languages] : [FALLBACK_LANGUAGE],
    description: null,
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

export const __testing = {
  toIdFromNpmName,
  toKebabCase,
  collectFrameworks,
  collectPublicApi,
  resolveIdCollisions,
}
