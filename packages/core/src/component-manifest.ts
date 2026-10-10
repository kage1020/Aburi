import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { toNfc } from "./codepoints"
import { CoreError } from "./errors"
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

export function collectPublicApi(manifest: NpmManifest | null): string[] {
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
