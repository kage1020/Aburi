import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { Component, ComponentId, LanguageId } from "@aburi/types"
import { glob } from "tinyglobby"
import { CoreError } from "./errors"
import { makeComponentId, makeLanguageId } from "./id"
import { CORE_IGNORE_PATTERNS } from "./scan/discover"
import { openGitignoreTree } from "./scan/gitignore"
import {
  detectManagers,
  isDirectory,
  type WorkspaceCandidate,
  type WorkspaceManager,
} from "./workspace"

/**
 * Language id assigned to each file extension when counting language frequency in a
 * candidate directory. The list mirrors docs/design/component-detect.md §4.4; the
 * future lang-plugin path will register additions on top of this table.
 */
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

/**
 * Heuristic mapping from npm dependency identifier (or Go module / Python dist) to the
 * framework id recorded on `Component.frameworks[]`. The detector matches by exact key
 * (or, where the key contains "*", a startsWith probe with the wildcard stripped).
 */
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

/** How far below a component root the language census looks (component-detect.md §4.4). */
const LANGUAGE_SCAN_DEPTH = 3

/** Language-frequency filter: skip extensions with fewer than this many files. */
const LANGUAGE_MIN_FILES = 10

/** Language-frequency filter: skip extensions whose share is below this fraction. */
const LANGUAGE_MIN_SHARE = 0.05

/**
 * Language recorded on a Component when frequency counting produced nothing — an empty
 * directory, or one whose files all sit below the thresholds above. `Component.languages`
 * is `minItems: 1` on the wire, so detection cannot hand back an empty list.
 */
const FALLBACK_LANGUAGE: LanguageId = makeLanguageId("ts")

export interface DetectComponentsOptions {
  /** Workspace root absolute path; same value passed to detectManagers. */
  workspaceRoot: string
  /**
   * Extra drop globs, on top of the core list — `config.ignore` and the file-drop patterns of
   * the loaded language plugins, which is exactly what discovery folds in. POSIX and
   * workspace-root relative, as the config schema says.
   *
   * There is no separate option for the plugin half, because a caller that knows one knows
   * both and the two are one list by the time they are applied. `aburi init` knows neither: it
   * detects components in order to *write* the first config, before any plugin is resolved, so
   * detection and discovery cannot be made to agree in every caller — only in the one where
   * disagreeing would put a language on a component whose files the same run refused to read.
   */
  ignore?: readonly string[]
  /**
   * Honour every directory's `.gitignore` while counting, as discovery does. Default `true`,
   * matching `config.respectGitignore`'s own default.
   */
  respectGitignore?: boolean
}

/**
 * Synthesize one `Component` per workspace candidate emitted by detectManagers. The result
 * always has at least one entry: when no managers fire, the workspace root itself becomes
 * a single-project Component (component-detect.md §5) so the rest of the pipeline never
 * has to handle a zero-Component IR.
 *
 * The function is async-only because language frequency counting and dependency-driven
 * framework discovery both walk the filesystem.
 */
export async function detectComponents(options: DetectComponentsOptions): Promise<Component[]> {
  const { workspaces } = await detectManagers(options.workspaceRoot)
  const merged = workspaces.length === 0 ? null : mergeCandidatesByPath(workspaces)
  // One walk for every root, before any component is built — see `countLanguagesPerRoot`.
  const languages = await countLanguagesPerRoot(
    options.workspaceRoot,
    merged === null ? ["."] : merged.map((entry) => entry.relativeRoot),
    options,
  )
  if (merged === null) {
    return [await buildSingleProjectComponent(options.workspaceRoot, languages.get(".") ?? [])]
  }

  const components = await Promise.all(
    merged.map((entry) => buildComponent(entry, languages.get(entry.relativeRoot) ?? [])),
  )
  return resolveIdCollisions(components).sort((a, b) => compareString(a.id, b.id))
}

export type { WorkspaceManager }
/** Re-export so callers can call detectManagers directly when they already have a root. */
export { detectManagers }

interface MergedCandidate {
  relativeRoot: string
  absoluteRoot: string
  managerTools: string[]
  manifestPath: string | null
}

function mergeCandidatesByPath(candidates: readonly WorkspaceCandidate[]): MergedCandidate[] {
  const byPath = new Map<string, MergedCandidate>()
  for (const c of candidates) {
    const existing = byPath.get(c.relativeRoot)
    if (existing === undefined) {
      byPath.set(c.relativeRoot, {
        relativeRoot: c.relativeRoot,
        absoluteRoot: c.absoluteRoot,
        managerTools: [c.managerTool],
        manifestPath: c.manifestPath,
      })
      continue
    }
    if (!existing.managerTools.includes(c.managerTool)) existing.managerTools.push(c.managerTool)
    if (existing.manifestPath === null && c.manifestPath !== null) {
      existing.manifestPath = c.manifestPath
    }
  }
  return [...byPath.values()]
}

async function buildComponent(
  entry: MergedCandidate,
  languages: readonly LanguageId[],
): Promise<Component> {
  const manifest = entry.manifestPath !== null ? await readPackageJson(entry.manifestPath) : null
  const id = decideId(entry, manifest)
  const name = decideName(entry, manifest)
  const frameworks = collectFrameworks(manifest)
  const publicApi = collectPublicApi(manifest)
  const component: Component = {
    id,
    name,
    roots: [entry.relativeRoot],
    languages: languages.length > 0 ? [...languages] : [FALLBACK_LANGUAGE],
    // Class A per ir-schema.md §1.1: always written, `null` when unset. Detection has no
    // source for a description; the config path (`resolveComponents` in @aburi/cli) writes
    // the same key from `components[].description`, so both producers agree on the shape.
    description: null,
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

async function buildSingleProjectComponent(
  workspaceRoot: string,
  languages: readonly LanguageId[],
): Promise<Component> {
  const manifestPath = join(workspaceRoot, "package.json")
  const manifest = (await pathExists(manifestPath)) ? await readPackageJson(manifestPath) : null
  const fakeEntry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot"> = {
    relativeRoot: ".",
    absoluteRoot: workspaceRoot,
  }
  const id = decideId(fakeEntry, manifest)
  const name = decideName(fakeEntry, manifest)
  const frameworks = collectFrameworks(manifest)
  const publicApi = collectPublicApi(manifest)
  const component: Component = {
    id,
    name,
    roots: ["."],
    languages: languages.length > 0 ? [...languages] : [FALLBACK_LANGUAGE],
    // Class A per ir-schema.md §1.1 -- see buildComponent.
    description: null,
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

/**
 * Pick the Component id, in the priority order of component-detect.md §4.1. Only steps 1 and
 * 5 of that list are implemented today — there is no Cargo / pyproject / go.mod branch yet.
 *
 * The result goes through `makeComponentId`, so a name that kebab-cases into something
 * `components[].id` cannot hold aborts detection instead of producing an IR that fails its
 * own schema. In practice only the empty result can reach that throw: kebab-casing maps every
 * other input into the pattern. The message carries where the name came from, because by the
 * time an id is unusable the interesting question is which package or directory produced it.
 */
function decideId(
  entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">,
  manifest: PackageJsonShape | null,
): ComponentId {
  const fromManifest = manifest?.name !== undefined ? toIdFromNpmName(manifest.name) : null
  if (fromManifest !== null) {
    return componentIdOrThrow(fromManifest, `package name "${manifest?.name}"`, entry.relativeRoot)
  }
  const segments = entry.relativeRoot.split("/").filter((s) => s.length > 0 && s !== ".")
  const leaf = segments[segments.length - 1] ?? basename(entry.absoluteRoot)
  return componentIdOrThrow(toKebabCase(leaf), `directory name "${leaf}"`, entry.relativeRoot)
}

/**
 * `makeComponentId` with the derivation's provenance attached. The bare constructor message
 * names only the offending id, which for the empty case is no information at all.
 */
function componentIdOrThrow(candidate: string, origin: string, root: string): ComponentId {
  try {
    return makeComponentId(candidate)
  } catch (cause) {
    throw new CoreError(
      `Cannot derive a Component id from ${origin} at "${root}": kebab-casing it yields ` +
        `"${candidate}", which is not ASCII kebab-case (ir-schema.md §4). Rename it, or ` +
        `declare the component explicitly under components[] in aburi.json.`,
      { code: "invalid-component-id", value: candidate },
      { cause },
    )
  }
}

function decideName(
  entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">,
  manifest: PackageJsonShape | null,
): string {
  if (manifest?.name !== undefined && manifest.name.length > 0) return manifest.name
  const segments = entry.relativeRoot.split("/").filter((s) => s.length > 0 && s !== ".")
  const leaf = segments[segments.length - 1] ?? basename(entry.absoluteRoot)
  return leaf
}

function toIdFromNpmName(npmName: string): string | null {
  if (npmName.length === 0) return null
  const stripped = npmName.startsWith("@") ? (npmName.split("/")[1] ?? "") : npmName
  if (stripped.length === 0) return null
  return toKebabCase(stripped)
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

/**
 * Count file extensions under every component root, dropping what a scan would drop.
 *
 * One walk from the workspace root rather than one per component, for two reasons. The rules
 * are workspace-root relative by contract — `config.ignore`'s `packages/app/fixtures/**` matches
 * nothing against a walk rooted at `packages/app`, and its `fixtures/**` would match the wrong
 * package — and the `.gitignore` matcher is keyed the same way. It also replaces N walks with
 * one.
 *
 * The depth limit survives as a per-root check after bucketing: still three levels below each
 * component root, which is no longer something a single `deep` can express.
 */
async function countLanguagesPerRoot(
  workspaceRoot: string,
  roots: readonly string[],
  options: DetectComponentsOptions,
): Promise<Map<string, LanguageId[]>> {
  const files = await glob(["**/*"], {
    cwd: workspaceRoot,
    ignore: [...CORE_IGNORE_PATTERNS, ...(options.ignore ?? [])],
    onlyFiles: true,
    // Written out rather than left to the default, so this and `discoverFiles` are provably the
    // same decision: `.git` is kept out of the census by this and not by a core pattern, and a
    // default that changed in a minor bump would start counting git objects towards a language.
    dot: false,
    deep: Math.max(...roots.map((root) => rootDepth(root) + LANGUAGE_SCAN_DEPTH)),
  })
  const gitignore = (options.respectGitignore ?? true) ? openGitignoreTree(workspaceRoot) : null

  const counts = new Map<string, Map<LanguageId, number>>(roots.map((root) => [root, new Map()]))
  for (const file of files) {
    const language = languageOfExtension(file)
    if (language === null) continue
    // Asked with the filesystem's own spelling, which is what git matches and what keys the
    // matcher. The bucketing below needs the other one — see `withinRoot`.
    if (gitignore !== null && (await gitignore.ignores(file))) continue
    const normalized = file.normalize("NFC")
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

/**
 * Whether a workspace-relative file sits under `root`, within the depth limit.
 *
 * The limit is counted in **directory levels**, which is the unit the walk's own `deep` uses:
 * `deep: 3` returns `a/b/c/f.ts`, three directories down. Counting path segments instead would
 * include the filename and quietly move the limit by one — and the file it drops,
 * `src/components/ui/*.tsx`, is the ordinary shape of a package this census exists to label.
 *
 * Both sides are NFC here. A component root arrives normalized from `toRelativePosix`, and the
 * walk returns the spelling the filesystem stored — so a decomposed directory name would fail
 * to contain its own files if either side were compared raw.
 */
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
  const dot = file.lastIndexOf(".")
  if (dot < 0) return null
  const raw = EXTENSION_TO_LANGUAGE.get(file.slice(dot).toLowerCase())
  if (raw === undefined) return null
  // The table is the boundary where a per-extension token becomes a LanguageId, so the
  // grammar check happens once here rather than at every consumer.
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
  return out.sort(compareString)
}

interface PackageJsonShape {
  name?: string
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

async function readPackageJson(path: string): Promise<PackageJsonShape | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as PackageJsonShape
  } catch {
    return null
  }
}

function collectFrameworks(manifest: PackageJsonShape | null): string[] {
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
  return [...out].sort(compareString)
}

/**
 * Gather the component's declared public surface from its manifest.
 *
 * Every value is put into Unicode NFC (ir-schema.md §1.2) because this function decides
 * both an identity and an order with them: the `Set` collapses duplicates and the result is
 * sorted. `@aburi/diff` then compares the array against the previous revision's, which was
 * read off disk and is therefore normalized — so an un-normalized entry here reports a
 * `publicApiChanged` for a component nobody touched.
 */
function collectPublicApi(manifest: PackageJsonShape | null): string[] {
  if (manifest === null) return []
  const found = new Set<string>()
  collectFromExports(manifest.exports, found)
  for (const candidate of [manifest.main, manifest.module, manifest.types, manifest.typings]) {
    const path = normalizePackagePath(candidate)
    if (path !== null) found.add(path)
  }
  return [...found].sort(compareString)
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

/**
 * The single funnel every `publicApi` entry passes through, whether it came from `exports`
 * or from one of the scalar keys — so the NFC normalization §1.2 requires cannot be applied
 * to one source and forgotten on the other.
 */
function normalizePackagePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || raw.length === 0) return null
  if (raw.includes("\\")) return null
  return raw.replace(/^\.\//, "").normalize("NFC")
}

/**
 * Guarantee Component.id uniqueness in three passes:
 *
 * 1. Try the parent-directory suffix (`shared` at `apps/shared` and `libs/shared` becomes
 *    `shared-apps` / `shared-libs`) — the human-readable case.
 * 2. If two collided components share the same parent segment (`team1/shared/pkg` and
 *    `team2/shared/pkg` both suffix to `pkg-shared`) or a suffix lands on another
 *    already-unique id, disambiguate with a stable `-2`, `-3`, … numeric tail.
 * 3. Validate that no id is duplicated on exit; anything left is a checker bug and must
 *    surface as an integrity failure downstream, not a silent duplicate here.
 */
function resolveIdCollisions(components: Component[]): Component[] {
  applyParentSuffixPass(components)
  applyNumericSuffixPass(components)
  return components
}

function applyParentSuffixPass(components: Component[]): void {
  const byId = new Map<ComponentId, Component[]>()
  for (const c of components) {
    const list = byId.get(c.id)
    if (list === undefined) byId.set(c.id, [c])
    else list.push(c)
  }
  for (const [id, group] of byId) {
    if (group.length <= 1) continue
    for (const c of group) {
      const segments = c.roots[0]?.split("/").filter((s) => s.length > 0 && s !== ".") ?? []
      const parent = segments.length > 1 ? segments[segments.length - 2] : null
      // A parent that kebab-cases to nothing would produce a trailing-hyphen id. Leave the
      // component unsuffixed instead and let the numeric pass separate it — the collision
      // still gets resolved, and a component whose id was fine does not fail detection
      // because of the segment above it.
      const suffix = parent === undefined || parent === null ? "" : toKebabCase(parent)
      c.id = suffix.length === 0 ? id : makeComponentId(`${id}-${suffix}`)
    }
  }
}

function applyNumericSuffixPass(components: Component[]): void {
  // Keyed by `string` so the probe below can test a candidate suffix without minting an id
  // for it. Appending `-2` to an id that is already valid cannot produce an invalid one, so
  // the constructor runs once, on the value actually assigned.
  const taken = new Set<string>()
  // Two collided components can survive the parent-suffix pass either because their parent
  // segments matched or because a rename collided with a third component. Walk in a stable
  // order (roots[0]) so the tail assignment is deterministic; the first occurrence keeps
  // its id and every subsequent duplicate takes -2, -3, …
  const ordered = [...components].sort((a, b) =>
    (a.roots[0] ?? "") < (b.roots[0] ?? "") ? -1 : (a.roots[0] ?? "") > (b.roots[0] ?? "") ? 1 : 0,
  )
  for (const c of ordered) {
    if (!taken.has(c.id)) {
      taken.add(c.id)
      continue
    }
    let n = 2
    while (taken.has(`${c.id}-${n}`)) n++
    c.id = makeComponentId(`${c.id}-${n}`)
    taken.add(c.id)
  }
}

async function pathExists(path: string): Promise<boolean> {
  return isDirectory(path)
    .then(
      (b) => b,
      () => false,
    )
    .then(async (asDir) => {
      if (asDir) return true
      try {
        await readFile(path, "utf8")
        return true
      } catch {
        return false
      }
    })
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Internal: surfaced for tests that want to verify the kebab transformer. */
export const __testing = {
  toIdFromNpmName,
  toKebabCase,
  collectFrameworks,
  collectPublicApi,
}
