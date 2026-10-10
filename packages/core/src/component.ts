import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { Component, ComponentId, LanguageId } from "@aburi/types"
import { glob } from "tinyglobby"
import { toNfc } from "./codepoints"
import { groupBy } from "./collections"
import { CoreError } from "./errors"
import { sha256Hex } from "./fingerprint/hash"
import { makeComponentId, makeLanguageId } from "./id"
import { compareBy, compareCodeUnit } from "./order"
import { CORE_IGNORE_PATTERNS } from "./scan/discover"
import { describeThrown, isVanishedFile } from "./scan/faults"
import { openGitignoreTree } from "./scan/gitignore"
import { fileExtension } from "./scan/route"
import { detectManagers, type WorkspaceCandidate, type WorkspaceManager } from "./workspace"

const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".py", "py"],
  [".go", "go"],
  [".rs", "rs"],
  [".java", "java"],
  [".kt", "kt"],
  [".kts", "kt"],
  [".scala", "scala"],
  [".rb", "rb"],
  [".php", "php"],
  [".cs", "cs"],
  [".swift", "swift"],
  [".ex", "ex"],
  [".exs", "ex"],
])

const NPM_DEP_TO_FRAMEWORK: ReadonlyArray<readonly [string, string]> = [
  ["@nestjs/core", "nestjs"],
  ["next", "nextjs"],
  ["react", "react"],
  ["vue", "vue"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["hono", "hono"],
  ["astro", "astro"],
  ["svelte", "svelte"],
  ["@sveltejs/kit", "svelte"],
  ["solid-js", "solid"],
  ["@trpc/server", "trpc"],
]

/** How far below a component root the language census looks (component-detect.md). */
const LANGUAGE_SCAN_DEPTH = 3

/** Language-frequency filter: skip extensions with fewer than this many files. */
const LANGUAGE_MIN_FILES = 10

/** Language-frequency filter: skip extensions whose share is below this fraction. */
const LANGUAGE_MIN_SHARE = 0.05

const FALLBACK_LANGUAGE: LanguageId = makeLanguageId("ts")

export interface DetectComponentsOptions {
  /** Workspace root absolute path; same value passed to detectManagers. */
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
  // One walk for every root, before any component is built — see `countLanguagesPerRoot`.
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

export type { WorkspaceManager }
/** Re-export so callers can call detectManagers directly when they already have a root. */
export { detectManagers }

const NPM_MANIFEST = "package.json"

const MANIFEST_PRIORITY: readonly string[] = [
  NPM_MANIFEST,
  "project.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
]

interface MergedCandidate {
  relativeRoot: string
  absoluteRoot: string
  managerTools: string[]
  manifests: Map<string, string>
}

function rootCandidate(workspaceRoot: string): MergedCandidate {
  return { relativeRoot: ".", absoluteRoot: workspaceRoot, managerTools: [], manifests: new Map() }
}

function mergeCandidatesByPath(candidates: readonly WorkspaceCandidate[]): MergedCandidate[] {
  const byPath = new Map<string, MergedCandidate>()
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.relativeRoot)
    if (existing === undefined) {
      byPath.set(candidate.relativeRoot, {
        relativeRoot: candidate.relativeRoot,
        absoluteRoot: candidate.absoluteRoot,
        managerTools: [candidate.managerTool],
        manifests: new Map([[basename(candidate.manifestPath), candidate.manifestPath]]),
      })
      continue
    }
    if (!existing.managerTools.includes(candidate.managerTool)) {
      existing.managerTools.push(candidate.managerTool)
    }
    existing.manifests.set(basename(candidate.manifestPath), candidate.manifestPath)
  }
  return [...byPath.values()]
}

function orderedManifests(manifests: ReadonlyMap<string, string>): [string, string][] {
  const ranked = [...manifests].filter(([kind]) => MANIFEST_PRIORITY.includes(kind))
  ranked.sort(([a], [b]) => MANIFEST_PRIORITY.indexOf(a) - MANIFEST_PRIORITY.indexOf(b))
  const unranked = [...manifests].filter(([kind]) => !MANIFEST_PRIORITY.includes(kind))
  unranked.sort(([a], [b]) => compareCodeUnit(a, b))
  return [...ranked, ...unranked]
}

interface ReadManifest {
  kind: string
  manifest: ManifestIdentity | null
}

async function readCandidateManifests(entry: MergedCandidate): Promise<ReadManifest[]> {
  const paths = new Map(entry.manifests)
  if (!paths.has(NPM_MANIFEST)) {
    paths.set(NPM_MANIFEST, join(entry.absoluteRoot, NPM_MANIFEST))
  }
  return Promise.all(
    orderedManifests(paths).map(async ([kind, path]) => ({
      kind,
      manifest: await readJsonManifest(path),
    })),
  )
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

function decideId(
  entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">,
  declaredNames: readonly string[],
): ComponentId {
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
        `"${candidate}", which is not ASCII kebab-case (ir-schema.md). Rename it, or ` +
        `declare the component explicitly under components[] in aburi.json.`,
      { code: "invalid-component-id", value: candidate },
      { cause },
    )
  }
}

function decideName(
  entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">,
  declaredNames: readonly string[],
): string {
  return declaredNames[0] ?? directoryLeaf(entry)
}

function declaredNames(manifests: readonly (ManifestIdentity | null)[]): string[] {
  const names: string[] = []
  for (const manifest of manifests) {
    const name = manifest?.name
    if (typeof name === "string" && name.length > 0) names.push(name)
  }
  return names
}

/** The trailing segment of the candidate's own path, or the root's directory name for `.`. */
function directoryLeaf(entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">): string {
  const segments = entry.relativeRoot.split("/").filter((s) => s.length > 0 && s !== ".")
  return segments[segments.length - 1] ?? basename(entry.absoluteRoot)
}

function toIdFromNpmName(npmName: string): string | null {
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

function toKebabCase(input: string): string {
  return input
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

async function countLanguagesPerRoot(
  workspaceRoot: string,
  roots: readonly string[],
  options: DetectComponentsOptions,
): Promise<Map<string, LanguageId[]>> {
  const files = await glob(["**/*"], {
    cwd: workspaceRoot,
    ignore: [...CORE_IGNORE_PATTERNS, ...(options.ignore ?? [])],
    onlyFiles: true,
    dot: false,
    deep: Math.max(...roots.map((root) => rootDepth(root) + LANGUAGE_SCAN_DEPTH)),
  })
  const gitignore = (options.respectGitignore ?? true) ? openGitignoreTree(workspaceRoot) : null

  const counts = new Map<string, Map<LanguageId, number>>(roots.map((root) => [root, new Map()]))
  for (const file of files) {
    const language = languageOfExtension(file)
    if (language === null) continue
    if (gitignore !== null && (await gitignore.ignores(file))) continue
    const normalized = toNfc(file)
    for (const root of roots) {
      if (!withinRoot(root, normalized)) continue
      const perRoot = counts.get(root)
      if (perRoot !== undefined) perRoot.set(language, (perRoot.get(language) ?? 0) + 1)
    }
  }
  return new Map([...counts].map(([root, perRoot]) => [root, frequentLanguages(perRoot)]))
}

/** `.` is the workspace root itself and has no segments. */
function rootDepth(root: string): number {
  return root === "." ? 0 : root.split("/").length
}

function withinRoot(root: string, file: string): boolean {
  if (root === ".") return directoryLevels(file) <= LANGUAGE_SCAN_DEPTH
  if (!file.startsWith(`${root}/`)) return false
  return directoryLevels(file.slice(root.length + 1)) <= LANGUAGE_SCAN_DEPTH
}

/** How many directories a relative file path descends through. `f.ts` is none. */
function directoryLevels(file: string): number {
  return file.split("/").length - 1
}

function languageOfExtension(file: string): LanguageId | null {
  const extension = fileExtension(file)
  const raw = extension === null ? undefined : EXTENSION_TO_LANGUAGE.get(extension)
  if (raw === undefined) return null
  return makeLanguageId(raw)
}

function frequentLanguages(counts: ReadonlyMap<LanguageId, number>): LanguageId[] {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const out: LanguageId[] = []
  for (const [lang, count] of counts) {
    if (count < LANGUAGE_MIN_FILES) continue
    if (count / total < LANGUAGE_MIN_SHARE) continue
    out.push(lang)
  }
  return out.sort(compareCodeUnit)
}

interface ManifestIdentity {
  name?: string
}

interface NpmManifest extends ManifestIdentity {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: unknown
  main?: string
  module?: string
  types?: string
  typings?: string
}

async function readJsonManifest(path: string): Promise<ManifestIdentity | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (cause) {
    if (isVanishedFile(cause)) return null
    throw new CoreError(
      `Manifest at ${path} could not be read: ${describeThrown(cause)}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new CoreError(
      `Failed to parse JSON at ${path}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as ManifestIdentity
}

function collectFrameworks(manifest: NpmManifest | null): string[] {
  if (manifest === null) return []
  const depKeys = new Set<string>()
  for (const block of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    if (block === undefined || block === null) continue
    for (const key of Object.keys(block)) depKeys.add(key)
  }
  const out = new Set<string>()
  for (const [dep, framework] of NPM_DEP_TO_FRAMEWORK) {
    if (depKeys.has(dep)) out.add(framework)
  }
  return [...out].sort(compareCodeUnit)
}

function collectPublicApi(manifest: NpmManifest | null): string[] {
  if (manifest === null) return []
  const found = new Set<string>()
  collectFromExports(manifest.exports, found)
  for (const candidate of [manifest.main, manifest.module, manifest.types, manifest.typings]) {
    const path = normalizePackagePath(candidate)
    if (path !== null) found.add(path)
  }
  return [...found].sort(compareCodeUnit)
}

function collectFromExports(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return
  if (typeof value === "string") {
    const path = normalizePackagePath(value)
    if (path !== null) out.add(path)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFromExports(entry, out)
    return
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value)) collectFromExports(entry, out)
  }
}

function normalizePackagePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || raw.length === 0) return null
  if (raw.includes("\\")) return null
  return toNfc(raw.replace(/^\.\//, ""))
}

function resolveIdCollisions(components: Component[]): Component[] {
  applyAncestorSuffixPass(components)
  applyRootHashPass(components)
  assertIdsUnique(components)
  return components
}

const ROOT_HASH_LENGTH = 8

/** A component's id while the ancestor pass is deciding how much of its path it needs. */
interface IdCandidate {
  readonly component: Component
  /** The id inference derived, before any suffix. */
  readonly base: ComponentId
  /** Ancestor directory segments of `roots[0]`, nearest first. */
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

/** The directories above `root`, nearest first. `packages/a` has one; `.` has none. */
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

export const __testing = {
  toIdFromNpmName,
  toKebabCase,
  collectFrameworks,
  collectPublicApi,
  resolveIdCollisions,
}
