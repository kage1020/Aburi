import { readFile } from "node:fs/promises"
import { basename, join, posix } from "node:path"
import type { Component, LanguageId } from "@aburi/types"
import { glob } from "tinyglobby"
import {
  detectManagers,
  isDirectory,
  type WorkspaceCandidate,
  type WorkspaceManager,
} from "./workspace"

/**
 * Language id assigned to each file extension when counting language frequency in a
 * candidate directory. The list mirrors design/details/component-detect.md §4.4; the
 * future lang-plugin path will register additions on top of this table.
 */
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, LanguageId> = new Map([
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

const GO_DEP_TO_FRAMEWORK: ReadonlyArray<readonly [string, string]> = [
  ["github.com/gin-gonic/gin", "gin"],
  ["github.com/labstack/echo", "echo"],
  ["github.com/gofiber/fiber", "fiber"],
]

const PY_DEP_TO_FRAMEWORK: ReadonlyArray<readonly [string, string]> = [
  ["django", "django"],
  ["fastapi", "fastapi"],
  ["flask", "flask"],
]

/** Language-frequency filter: skip extensions with fewer than this many files. */
const LANGUAGE_MIN_FILES = 10

/** Language-frequency filter: skip extensions whose share is below this fraction. */
const LANGUAGE_MIN_SHARE = 0.05

export interface DetectComponentsOptions {
  /** Workspace root absolute path; same value passed to detectManagers. */
  workspaceRoot: string
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
  if (workspaces.length === 0) {
    return [await buildSingleProjectComponent(options.workspaceRoot)]
  }

  const merged = mergeCandidatesByPath(workspaces)
  const components = await Promise.all(merged.map((entry) => buildComponent(entry)))
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

async function buildComponent(entry: MergedCandidate): Promise<Component> {
  const manifest = entry.manifestPath !== null ? await readPackageJson(entry.manifestPath) : null
  const id = decideId(entry, manifest)
  const name = decideName(entry, manifest)
  const languages = await detectLanguagesForDirectory(entry.absoluteRoot)
  const frameworks = collectFrameworks(manifest)
  const publicApi = collectPublicApi(manifest)
  const component: Component = {
    id,
    name,
    roots: [entry.relativeRoot],
    languages: languages.length > 0 ? languages : ["ts"],
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

async function buildSingleProjectComponent(workspaceRoot: string): Promise<Component> {
  const manifestPath = join(workspaceRoot, "package.json")
  const manifest = (await pathExists(manifestPath)) ? await readPackageJson(manifestPath) : null
  const fakeEntry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot"> = {
    relativeRoot: ".",
    absoluteRoot: workspaceRoot,
  }
  const id = decideId(fakeEntry, manifest)
  const name = decideName(fakeEntry, manifest)
  const languages = await detectLanguagesForDirectory(workspaceRoot)
  const frameworks = collectFrameworks(manifest)
  const publicApi = collectPublicApi(manifest)
  const component: Component = {
    id,
    name,
    roots: ["."],
    languages: languages.length > 0 ? languages : ["ts"],
  }
  if (publicApi.length > 0) component.publicApi = publicApi
  if (frameworks.length > 0) component.frameworks = frameworks
  return component
}

function decideId(
  entry: Pick<MergedCandidate, "relativeRoot" | "absoluteRoot">,
  manifest: PackageJsonShape | null,
): string {
  const fromManifest = manifest?.name !== undefined ? toIdFromNpmName(manifest.name) : null
  if (fromManifest !== null) return fromManifest
  const segments = entry.relativeRoot.split("/").filter((s) => s.length > 0 && s !== ".")
  const leaf = segments[segments.length - 1] ?? basename(entry.absoluteRoot)
  return toKebabCase(leaf)
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

async function detectLanguagesForDirectory(absoluteRoot: string): Promise<LanguageId[]> {
  const files = await glob(["**/*"], {
    cwd: absoluteRoot,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.next/**",
      "**/__pycache__/**",
      "**/target/**",
    ],
    onlyFiles: true,
    deep: 3,
  })
  if (files.length === 0) return []
  const counts = new Map<LanguageId, number>()
  for (const file of files) {
    const dot = file.lastIndexOf(".")
    if (dot < 0) continue
    const ext = file.slice(dot).toLowerCase()
    const lang = EXTENSION_TO_LANGUAGE.get(ext)
    if (lang === undefined) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
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
  // Go / Python lookups are placeholders for future polyglot detection; v0.1 only emits
  // the JS/TS subset, but the framework lookup table is shaped so adding manifests later
  // is purely additive.
  for (const [_dep, _framework] of GO_DEP_TO_FRAMEWORK) {
    void _dep
    void _framework
  }
  for (const [_dep, _framework] of PY_DEP_TO_FRAMEWORK) {
    void _dep
    void _framework
  }
  return [...out].sort(compareString)
}

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

function normalizePackagePath(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string" || raw.length === 0) return null
  if (raw.includes("\\")) return null
  return raw.replace(/^\.\//, "")
}

function resolveIdCollisions(components: Component[]): Component[] {
  const byId = new Map<string, Component[]>()
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
      c.id = parent !== undefined && parent !== null ? `${id}-${toKebabCase(parent)}` : id
    }
  }
  return components
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

void posix
