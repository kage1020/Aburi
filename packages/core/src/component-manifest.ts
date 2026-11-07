import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { toNfc } from "./codepoints"
import { CoreError } from "./errors"
import { unnameableSite } from "./id"
import { compareCodeUnit } from "./order"
import { describeThrown, isVanishedFile } from "./scan/faults"
import { parseManifestJson } from "./workspace-fs"

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

export const NPM_MANIFEST = "package.json"

const MANIFEST_PRIORITY: readonly string[] = [
  NPM_MANIFEST,
  "project.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
]

function orderedManifests(manifests: ReadonlyMap<string, string>): [string, string][] {
  const ranked = [...manifests].filter(([kind]) => MANIFEST_PRIORITY.includes(kind))
  ranked.sort(([a], [b]) => MANIFEST_PRIORITY.indexOf(a) - MANIFEST_PRIORITY.indexOf(b))
  const unranked = [...manifests].filter(([kind]) => !MANIFEST_PRIORITY.includes(kind))
  unranked.sort(([a], [b]) => compareCodeUnit(a, b))
  return [...ranked, ...unranked]
}

export interface ReadManifest {
  kind: string
  manifest: ManifestIdentity | null
}

export async function readCandidateManifests(entry: {
  readonly absoluteRoot: string
  readonly manifests: ReadonlyMap<string, string>
}): Promise<ReadManifest[]> {
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

/** A `package.json#name` and the workspace-relative root whose manifest declares it. */
export interface WorkspacePackage {
  name: string
  root: string
}

export async function readWorkspacePackages(
  workspaceRoot: string,
  roots: readonly string[],
): Promise<WorkspacePackage[]> {
  const unique = [...new Set(roots)].sort(compareCodeUnit)
  // Which read fails first is timing, so the failure reported is the first root's.
  const settled = await Promise.allSettled(
    unique.map(async (root) => ({
      root,
      manifest: await readJsonManifest(join(workspaceRoot, root, NPM_MANIFEST)),
    })),
  )
  return settled.flatMap((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason
    const { root, manifest } = outcome.value
    const name: unknown = manifest?.name
    return typeof name === "string" && name.length > 0 ? [{ name, root }] : []
  })
}

export interface ManifestIdentity {
  name?: string
}

export interface NpmManifest extends ManifestIdentity {
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
  const parsed = parseManifestJson(raw, path)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as ManifestIdentity
}

export function collectFrameworks(manifest: NpmManifest | null): string[] {
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

export type IgnoredPublicApiReason =
  | "package-directory"
  | "directory"
  | "absolute-path"
  | "parent-segment"
  | "drive-shaped-name"
  | "unspellable-name"

/** A string `package.json` value that names no file inside the package, so it gives no entry. */
export interface IgnoredPublicApiValue {
  /** `main`, `module`, `types`, `typings`, or the place in `exports`: `exports["./lib/"]`. */
  field: string
  value: string
  reason: IgnoredPublicApiReason
}

export interface PublicApi {
  /** Workspace-relative, sorted. */
  entries: string[]
  ignored: IgnoredPublicApiValue[]
}

const TOP_LEVEL_PATH_FIELDS = ["main", "module", "types", "typings"] as const

export function collectPublicApi(manifest: NpmManifest | null, root: string): PublicApi {
  const found = new Set<string>()
  const ignored: IgnoredPublicApiValue[] = []
  const take = (field: string, raw: unknown): void => {
    if (typeof raw !== "string") return
    const outcome = normalizePackagePath(raw)
    if (typeof outcome === "string") found.add(root === "." ? outcome : `${root}/${outcome}`)
    else ignored.push({ field, value: raw, reason: outcome.reason })
  }
  if (manifest !== null) {
    collectFromExports(manifest.exports, "exports", take)
    for (const field of TOP_LEVEL_PATH_FIELDS) take(field, manifest[field])
  }
  return { entries: [...found].sort(compareCodeUnit), ignored }
}

function collectFromExports(
  value: unknown,
  field: string,
  take: (field: string, raw: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectFromExports(entry, `${field}[${index}]`, take)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectFromExports(entry, `${field}[${JSON.stringify(key)}]`, take)
    }
    return
  }
  take(field, value)
}

function normalizePackagePath(raw: string): string | { reason: IgnoredPublicApiReason } {
  if (raw.startsWith("/")) return { reason: "absolute-path" }
  const segments = toNfc(raw).split("/")
  const kept = segments.filter((segment) => segment.length > 0 && segment !== ".")
  if (kept.length === 0) return { reason: "package-directory" }
  const last = segments[segments.length - 1]
  if (last === "" || last === ".") return { reason: "directory" }
  const path = kept.join("/")
  const site = unnameableSite(path)
  if (site !== null) return { reason: site.reason }
  // An entry is the value's own spelling, so `./src/../index.js` is refused though it stays inside.
  if (kept.includes("..")) return { reason: "parent-segment" }
  return path
}
