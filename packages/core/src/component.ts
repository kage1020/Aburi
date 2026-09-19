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

/**
 * Language id assigned to each file extension when counting language frequency in a
 * candidate directory. The list mirrors docs/design/component-detect.md; the
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

/** How far below a component root the language census looks (component-detect.md). */
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
 * a single-project Component (component-detect.md) so the rest of the pipeline never
 * has to handle a zero-Component IR.
 *
 * The function is async-only because language frequency counting and dependency-driven
 * framework discovery both walk the filesystem.
 */
export async function detectComponents(options: DetectComponentsOptions): Promise<Component[]> {
  const { workspaces } = await detectManagers(options.workspaceRoot)
  // The single-project fallback (component-detect.md): the workspace root as the one
  // candidate, described by whatever `package.json` it holds.
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

/**
 * The manifest whose fields `Component.frameworks` and `Component.publicApi` are defined over
 * — `dependencies` and `exports` are npm's, and a file that is not an npm manifest does not
 * have them however its own keys happen to be spelled.
 */
const NPM_MANIFEST = "package.json"

/**
 * Manifest filenames in the order component-detect.md reads them for a Component's
 * identity. A directory several detectors claim is described by all of their manifests, and
 * this is which one answers first — by filename rather than by which detector arrived first,
 * so the order `detectManagers` sorts its tools in cannot move a Component's id.
 *
 * The three id-inference names no detector produces yet are listed anyway: a filename absent
 * from
 * this list is ordered after every name in it and against its peers alphabetically, which is
 * deterministic but says nothing about what the manifest means.
 */
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
  /**
   * The manifests describing this directory, by filename. Keyed rather than listed because
   * the key is what decides the reading order and what `frameworks` and `publicApi` are
   * looked up by, and a list would carry that meaning only in its index.
   */
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

/**
 * This candidate's manifests as `[filename, path]`, in the order id inference reads them. A
 * filename
 * the order does not name comes after every one it does, and against its peers by name — a
 * decision that is at least the same on every machine.
 */
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

/**
 * Every manifest describing this directory, parsed, in id inference's reading order.
 *
 * The `package.json` under the candidate root is read whether or not a detector reported it.
 * A directory holding one is an npm package however it was found, and letting the detector set
 * decide otherwise makes a Component's identity depend on a file elsewhere in the workspace:
 * `detectNx` reports the `project.json` alone, so in an nx workspace with no
 * `pnpm-workspace.yaml` and no `workspaces` key every `package.json` in it would go unread —
 * published name, frameworks and public API with it.
 */
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
    // Class A per ir-schema.md: always written, `null` when unset. Detection has no
    // source for a description; the config path (`resolveComponents` in @aburi/cli) writes
    // the same key from `components[].description`, so both producers agree on the shape.
    description: null,
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

/**
 * Pick the Component id, in the priority order of component-detect.md. Of the sources
 * that list names, `package.json#name` and `project.json#name` have detectors today; the
 * Cargo, pyproject and go.mod branches arrive with theirs, and the directory name is the last
 * resort for every candidate.
 *
 * A declared name that yields no id is not an answer either, so the next one is asked before
 * the directory name is — `@scope/` names a package badly enough that nothing can be built
 * from it, and a `project.json` beside it may name the same directory perfectly well.
 *
 * The result goes through `makeComponentId`, so a name that kebab-cases into something
 * `components[].id` cannot hold aborts detection instead of producing an IR that fails its
 * own schema. In practice only the empty result can reach that throw: kebab-casing maps every
 * other input into the pattern. The message carries where the name came from, because by the
 * time an id is unusable the interesting question is which package or directory produced it.
 */
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

/**
 * Every name these manifests declare, in the order they were read.
 *
 * `id` and `name` inference are priority orders over *sources*, so a manifest that carries no
 * name is not
 * an answer — the next one is asked before the directory name is. That matters where the two
 * disagree about what exists rather than about the value: an nx `project.json` names a project
 * even for a directory whose `package.json` is a private stub with no `name` at all.
 *
 * The `typeof` is not decoration. A manifest is JSON someone else's tool wrote, `name` is
 * whatever that JSON holds, and an array has a `length` — enough to pass a truthiness check
 * and then fail inside the id derivation, which reads it as a string.
 */
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

/**
 * The id a published npm name yields, with the scope folded in rather than discarded:
 * `@alpha/utils` is `alpha-utils`, not `utils` (component-detect.md).
 *
 * Three answers, and the difference between the last two is what id inference means by a
 * priority over *sources*:
 *
 * - `null` — this name says nothing id inference can use, so the next manifest is asked.
 *   `@scope/` and a bare `@scope` are that: `name` inference has a name, `id` inference has
 *   none.
 * - `""` — this name is the answer, and it cannot be an id. `componentIdOrThrow` says so and
 *   names the package, rather than falling through to the directory.
 * - anything else — the id.
 *
 * The bare part is kebab-cased on its own before the scope is prepended, so a name the
 * grammar cannot express stays the second case. Folded in one pass it would not: `toKebabCase`
 * drops the trailing hyphen, so `@acme/---` and a scope-plus-non-ASCII name would both come
 * back as `acme` — the scope alone, silently, and identical for every unusable name in that
 * scope.
 */
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
  const extension = fileExtension(file)
  const raw = extension === null ? undefined : EXTENSION_TO_LANGUAGE.get(extension)
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
  return out.sort(compareCodeUnit)
}

/**
 * What every manifest kind has in common — the `name` that id and name inference read. It is
 * all a
 * `project.json` shares with a `package.json`, so it is what a parse is typed as until
 * something establishes which file it came from.
 */
interface ManifestIdentity {
  name?: string
}

/**
 * An npm manifest. `dependencies` and `exports` are npm's fields, so a value of this type is
 * one that came from a `package.json` — `buildComponent` is the only place that is decided,
 * which is what stops `collectFrameworks` being handed an nx project file whose targets
 * happen to hold a key of that name.
 */
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

/**
 * Parse a manifest, or return null when there is none there.
 *
 * Absent is silent and present-but-unusable is not, which is the line `readGitignore` and
 * `detectPnpm` already draw: a directory without a `package.json` is the ordinary case and
 * says nothing, while one whose manifest cannot be read has an identity that this run cannot
 * see. Swallowing that would answer with the next manifest's name, or with the directory's,
 * and nothing would say the published name was ever there — the misattribution
 * `assertInsideWorkspace` refuses for a neighbouring case in the same package.
 *
 * A parse that is not an object is a manifest that declares nothing rather than one that
 * cannot be read, and is null: `workspace.ts` reads the root's own `package.json` the same
 * way when deciding whether it declares workspaces.
 */
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

/**
 * Gather the component's declared public surface from its manifest.
 *
 * Every value is put into Unicode NFC (ir-schema.md) because this function decides
 * both an identity and an order with them: the `Set` collapses duplicates and the result is
 * sorted. `@aburi/diff` then compares the array against the previous revision's, which was
 * read off disk and is therefore normalized — so an un-normalized entry here reports a
 * `publicApiChanged` for a component nobody touched.
 */
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

/**
 * The single funnel every `publicApi` entry passes through, whether it came from `exports`
 * or from one of the scalar keys — so the NFC normalization ir-schema.md requires cannot be
 * applied
 * to one source and forgotten on the other.
 */
function normalizePackagePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || raw.length === 0) return null
  if (raw.includes("\\")) return null
  return toNfc(raw.replace(/^\.\//, ""))
}

/**
 * Guarantee Component.id uniqueness, order-independently (component-detect.md).
 *
 * 1. Walk up `roots[0]`, one ancestor directory at a time, suffixing every id that is still
 *    shared, until each is unique or its root has no ancestors left.
 * 2. Whatever the path could not separate takes a hash of `roots[0]` on top of the id it
 *    reached.
 * 3. Refuse to hand back a duplicate. Only a hash collision reaches this, and the caller it
 *    protects is `aburi init`, which writes `components[]` without ever building an IR — so
 *    the #2 integrity check downstream never sees it.
 *
 * What the passes never read is a component's position in the list. `consumedAncestors` does
 * depend on the set of ids a component contends with — a package that arrives claiming an id in use
 * moves someone — but that is a contended id rather than, as before, any package under the
 * same parent renumbering its neighbours.
 */
function resolveIdCollisions(components: Component[]): Component[] {
  applyAncestorSuffixPass(components)
  applyRootHashPass(components)
  assertIdsUnique(components)
  return components
}

/**
 * How many hex characters of the root digest the last-resort suffix carries. Short enough to
 * stay readable in an id, against a space that is the handful of components in one workspace
 * whose whole path chain kebab-cases to the same thing. `assertIdsUnique` covers the rest.
 */
const ROOT_HASH_LENGTH = 8

/** A component's id while the ancestor pass is deciding how much of its path it needs. */
interface IdCandidate {
  readonly component: Component
  /** The id inference derived, before any suffix. */
  readonly base: ComponentId
  /** Ancestor directory segments of `roots[0]`, nearest first. */
  readonly ancestors: readonly string[]
  /**
   * How many of them this round has consumed — not how many the id carries. A segment that
   * kebab-cases to nothing is consumed and contributes no suffix, which is exactly how a
   * round can advance without changing an id.
   */
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
        // A candidate that has run out of path is left where it is rather than blocking the
        // rest of its group: the ones that can still move may well separate from it, and the
        // hash pass takes whatever is left.
        if (candidate.consumedAncestors >= candidate.ancestors.length) continue
        candidate.consumedAncestors++
        extended = true
      }
    }
    // Every round either lengthens at least one suffix — bounded by that root's depth — or
    // ends the pass, so the loop terminates.
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

/**
 * The last resort, for ids the path could not separate. Every member of a surviving group
 * takes the hash — including the one that would have kept the bare id under a positional
 * scheme, because "which one was first" is exactly the input this pass exists to avoid.
 */
function applyRootHashPass(components: Component[]): void {
  for (const group of groupBy(components, (component) => component.id).values()) {
    if (group.length <= 1) continue
    for (const component of group) {
      component.id = hashedId(component.id, component.roots[0] ?? "")
    }
  }
}

/**
 * The exit check the passes above cannot make for themselves.
 *
 * `applyRootHashPass` separates a group by digest rather than by construction, so uniqueness
 * is overwhelmingly likely rather than certain. Where the result becomes an IR, invariant
 * #2 catches a duplicate; `aburi init` writes `components[]` straight to `aburi.json` and
 * builds no IR, so without this it would persist the duplicate and report success.
 */
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

/**
 * `base` carrying its first `consumed` ancestors as a suffix.
 *
 * A segment that kebab-cases to nothing contributes nothing rather than a doubled or trailing
 * hyphen — the id stays valid, the collision stays unresolved, and the next round (or the
 * hash pass) deals with it. A component whose own id was fine does not fail detection because
 * of the segment above it.
 */
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

/**
 * `id` with a digest of `root` appended. Its own width rather than `hashRawString`'s: that
 * one is the fingerprint path, whose width is chosen for a different question, and an id
 * respelled by a fingerprint constant moving would be a change nobody was making.
 *
 * `root` is already NFC — `toRelativePosix` normalizes it, which is what lets `withinRoot`
 * compare roots against walk output raw — so the digest is of the same bytes on every machine.
 */
function hashedId(id: ComponentId, root: string): ComponentId {
  return makeComponentId(`${id}-${sha256Hex(root).slice(0, ROOT_HASH_LENGTH)}`)
}

/**
 * Internal: surfaced for tests that want a derivation on its own.
 *
 * `resolveIdCollisions` is here because the alternative is reaching it through a tmpdir of
 * seeded files: it is the one pass whose interesting cases are about *which* components exist
 * together, and a table of them should cost a line each. It mutates the components handed to
 * it and returns the same array.
 */
export const __testing = {
  toIdFromNpmName,
  toKebabCase,
  collectFrameworks,
  collectPublicApi,
  resolveIdCollisions,
}
