import { open, readdir, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import type { WorkspaceManager } from "@aburi/types"
import { glob } from "tinyglobby"
import { parse as parseYaml } from "yaml"
import { toNfc } from "./codepoints"
import { CoreError } from "./errors"
import { posixWorkspaceRelativeViolation } from "./id"
import { compareBy, compareCodeUnit } from "./order"
import { describeJsonType, isVanishedFile } from "./scan/faults"

const REPOSITORY_MARKER = ".git"

const GITDIR_POINTER = "gitdir: "

const ROOT_MARKERS = [
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "go.work",
  ".aburi-workspace",
] as const

const CONDITIONAL_ROOT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml"] as const

type RootMarker =
  | typeof REPOSITORY_MARKER
  | (typeof ROOT_MARKERS)[number]
  | (typeof CONDITIONAL_ROOT_MARKERS)[number]

export interface DetectWorkspaceRootOptions {
  cwd?: string
}

export async function detectWorkspaceRoot(
  options: DetectWorkspaceRootOptions = {},
): Promise<string> {
  const startRaw = options.cwd ?? process.cwd()
  const start = isAbsolute(startRaw) ? startRaw : resolve(process.cwd(), startRaw)

  let dir = start
  let outermost: string | null = null
  let failure: MarkerFailure | null = null
  while (true) {
    const probe = await probeDirectoryMarkers(dir)
    if (probe.marker !== null) outermost = dir
    if (failure === null && probe.failure !== null) failure = { dir, cause: probe.failure }
    if (probe.marker === REPOSITORY_MARKER) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (outermost === null) {
    throw new CoreError(
      `No workspace marker (.git, pnpm-workspace.yaml, turbo.json, nx.json, lerna.json, go.work, .aburi-workspace, or workspace-aware package.json/Cargo.toml/pyproject.toml) found at ${start} or any ancestor`,
      { code: "workspace-root-not-found", value: start },
    )
  }
  if (failure !== null && isAtOrBelow(failure.dir, outermost)) throw failure.cause
  return outermost
}

/** The first marker probe that could not answer, and the directory it was probing. */
interface MarkerFailure {
  dir: string
  cause: unknown
}

interface MarkerProbe {
  /** The marker this directory carries, or `null` when it carries none. */
  marker: RootMarker | null
  /** The first error a probe of this directory raised, or `null` when every probe answered. */
  failure: unknown
}

async function probeDirectoryMarkers(dir: string): Promise<MarkerProbe> {
  let failure: unknown = null
  const remember = (cause: unknown): void => {
    if (failure === null) failure = cause
  }
  try {
    if (await isRepository(join(dir, REPOSITORY_MARKER))) {
      return { marker: REPOSITORY_MARKER, failure }
    }
  } catch (cause) {
    remember(cause)
  }
  for (const name of ROOT_MARKERS) {
    try {
      if (await pathExists(join(dir, name))) return { marker: name, failure }
    } catch (cause) {
      remember(cause)
    }
  }
  for (const name of CONDITIONAL_ROOT_MARKERS) {
    const path = join(dir, name)
    try {
      if (!(await pathExists(path))) continue
      if (await fileSatisfiesWorkspacePredicate(name, path)) return { marker: name, failure }
    } catch (cause) {
      remember(cause)
    }
  }
  return { marker: null, failure }
}

async function isRepository(path: string): Promise<boolean> {
  let entry: Awaited<ReturnType<typeof stat>>
  try {
    entry = await stat(path)
  } catch (err: unknown) {
    if (isVanishedFile(err)) return false
    throw err
  }
  if (entry.isDirectory()) return true
  if (!entry.isFile()) return false
  const opening = Buffer.alloc(GITDIR_POINTER.length)
  const handle = await open(path, "r")
  try {
    const { bytesRead } = await handle.read(opening, 0, opening.length, 0)
    return opening.subarray(0, bytesRead).toString("utf8") === GITDIR_POINTER
  } finally {
    await handle.close()
  }
}

function isAtOrBelow(dir: string, root: string): boolean {
  if (dir === root) return true
  return dir.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function fileSatisfiesWorkspacePredicate(
  marker: (typeof CONDITIONAL_ROOT_MARKERS)[number],
  path: string,
): Promise<boolean> {
  switch (marker) {
    case "package.json":
      return packageJsonDeclaresWorkspaces(path)
    case "Cargo.toml":
      return tomlContainsWorkspaceSection(path)
    case "pyproject.toml":
      return pyprojectDeclaresWorkspace(path)
  }
}

async function packageJsonDeclaresWorkspaces(path: string): Promise<boolean> {
  const parsed = await readJson(path)
  if (parsed === null || typeof parsed !== "object") return false
  return "workspaces" in (parsed as Record<string, unknown>)
}

async function tomlContainsWorkspaceSection(path: string): Promise<boolean> {
  const text = await readText(path)
  return /^\s*\[workspace\]/m.test(text) || /^\s*\[workspace\.members\]/m.test(text)
}

async function pyprojectDeclaresWorkspace(path: string): Promise<boolean> {
  const text = await readText(path)
  return (
    /^\s*\[tool\.uv\.workspace\]/m.test(text) ||
    /^\s*\[tool\.hatch\.workspaces\]/m.test(text) ||
    /^\s*\[tool\.poetry\]/m.test(text)
  )
}

export interface DetectManagersResult {
  managers: WorkspaceManager[]
  workspaces: WorkspaceCandidate[]
  unresolved: UnresolvedDeclaration[]
}

/** A manifest's package patterns, none of which named a package. */
export interface UnresolvedDeclaration {
  /** The tool whose manifest declared them, as spelled on `managers[].tool`. */
  tool: string
  manifestPath: string
  /** Every string the manifest lists, including ones the resolver drops. */
  patterns: readonly string[]
}

export interface WorkspaceCandidate {
  /** Workspace-root-relative POSIX path of the candidate directory. */
  relativeRoot: string
  /** Absolute path of the candidate directory. */
  absoluteRoot: string
  /** Tool that produced this candidate (the same path may appear once per tool). */
  managerTool: string
  manifestPath: string
}

export async function detectManagers(workspaceRoot: string): Promise<DetectManagersResult> {
  const managers: WorkspaceManager[] = []
  const workspaces: WorkspaceCandidate[] = []
  const unresolved: UnresolvedDeclaration[] = []
  const seen = new Set<string>()
  const merge = (scan: ManagerScan | null): void => {
    mergeManager(scan, managers, workspaces, seen)
    if (scan !== null && scan.declaredPatterns.length > 0 && scan.candidates.length === 0) {
      unresolved.push({
        tool: scan.tool,
        manifestPath: toRelativePosix(workspaceRoot, scan.manifestPath),
        patterns: scan.declaredPatterns,
      })
    }
  }

  await Promise.all([
    detectPnpm(workspaceRoot).then(merge),
    detectPackageJsonWorkspaces(workspaceRoot).then((managerScans) => {
      for (const managerScan of managerScans) merge(managerScan)
    }),
    detectTurbo(workspaceRoot).then(merge),
    detectNx(workspaceRoot).then(merge),
  ])

  managers.sort(compareBy((manager) => manager.tool))
  for (const manager of managers) manager.roots.sort(compareCodeUnit)
  workspaces.sort(
    (a, b) =>
      compareCodeUnit(a.relativeRoot, b.relativeRoot) ||
      compareCodeUnit(a.managerTool, b.managerTool),
  )
  unresolved.sort(
    (a, b) => compareCodeUnit(a.tool, b.tool) || compareCodeUnit(a.manifestPath, b.manifestPath),
  )
  return { managers, workspaces, unresolved }
}

interface ManagerScan {
  tool: string
  candidates: WorkspaceCandidate[]
  /** Absolute path of the manifest this scan read. */
  manifestPath: string
  declaredPatterns: readonly string[]
}

function mergeManager(
  scan: ManagerScan | null,
  managers: WorkspaceManager[],
  workspaces: WorkspaceCandidate[],
  seen: Set<string>,
): void {
  if (scan === null) return
  const roots = new Set<string>()
  for (const candidate of scan.candidates) {
    assertInsideWorkspace(candidate, scan.tool)
    roots.add(candidate.relativeRoot)
    const key = `${candidate.managerTool}\t${candidate.relativeRoot}`
    if (seen.has(key)) continue
    seen.add(key)
    workspaces.push(candidate)
  }
  managers.push({ tool: scan.tool, roots: [...roots] })
}

function assertInsideWorkspace(candidate: WorkspaceCandidate, tool: string): void {
  const violation = posixWorkspaceRelativeViolation(
    candidate.relativeRoot,
    `${tool} workspace root`,
  )
  if (violation === null) return
  throw new CoreError(
    `${violation.message}. A package outside the workspace root cannot be described by this IR, and the file walk never reaches it — declare it from the workspace that contains it, or move the workspace root.`,
    { code: "workspace-root-outside", value: candidate.relativeRoot },
  )
}

async function detectPnpm(root: string): Promise<ManagerScan | null> {
  const manifestPath = join(root, "pnpm-workspace.yaml")
  if (!(await pathExists(manifestPath))) return null
  const text = await readText(manifestPath)
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (cause) {
    throw new CoreError(
      `Failed to parse pnpm-workspace.yaml at ${manifestPath}`,
      { code: "workspace-manifest-malformed", value: manifestPath },
      { cause },
    )
  }
  const patterns = readPatternList(parsed, "packages", manifestPath)
  const candidates = await resolveDeclaredPackages(root, patterns, "pnpm")
  return { tool: "pnpm", candidates, manifestPath, declaredPatterns: patterns }
}

async function detectPackageJsonWorkspaces(root: string): Promise<ManagerScan[]> {
  const manifestPath = join(root, "package.json")
  if (!(await pathExists(manifestPath))) return []
  const parsed = await readJson(manifestPath)
  const patterns = extractWorkspacePatterns(parsed, manifestPath)
  if (patterns.length === 0) return []
  const tool = await detectJsPackageManagerTool(root)
  const candidates = await resolveDeclaredPackages(root, patterns, tool)
  return [{ tool, candidates, manifestPath, declaredPatterns: patterns }]
}

function extractWorkspacePatterns(parsed: unknown, manifestPath: string): string[] {
  if (parsed === null || typeof parsed !== "object") return []
  const ws = (parsed as { workspaces?: unknown }).workspaces
  if (ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
    return readPatternList(ws, "packages", manifestPath)
  }
  return readPatternList(parsed, "workspaces", manifestPath)
}

async function detectJsPackageManagerTool(root: string): Promise<string> {
  if (await pathExists(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (await pathExists(join(root, "yarn.lock"))) return "yarn"
  if (await pathExists(join(root, "bun.lockb"))) return "bun"
  if (await pathExists(join(root, "bun.lock"))) return "bun"
  return "npm"
}

async function detectTurbo(root: string): Promise<ManagerScan | null> {
  const manifestPath = join(root, "turbo.json")
  if (!(await pathExists(manifestPath))) return null
  return { tool: "turbo", candidates: [], manifestPath, declaredPatterns: [] }
}

async function detectNx(root: string): Promise<ManagerScan | null> {
  const manifestPath = join(root, "nx.json")
  if (!(await pathExists(manifestPath))) return null
  const projectFiles = await glob(["**/project.json"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    onlyFiles: true,
    absolute: true,
    deep: 10,
  })
  const candidates: WorkspaceCandidate[] = []
  for (const projectFile of projectFiles) {
    const dir = dirname(projectFile)
    candidates.push({
      relativeRoot: toRelativePosix(root, dir),
      absoluteRoot: dir,
      managerTool: "nx",
      manifestPath: projectFile,
    })
  }
  return { tool: "nx", candidates, manifestPath, declaredPatterns: [] }
}

/** The manifest a pnpm/npm/yarn/bun `packages:` entry promises the directory holds. */
const JS_PACKAGE_MANIFEST = "package.json"

async function resolveDeclaredPackages(
  workspaceRoot: string,
  patterns: readonly string[],
  managerTool: string,
): Promise<WorkspaceCandidate[]> {
  const manifestPatterns = patterns.filter((p) => p.length > 0).map(toManifestPattern)
  const manifests = await glob(manifestPatterns, {
    cwd: workspaceRoot,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    expandDirectories: false,
    absolute: true,
    deep: 10,
  })
  return manifests.map((manifestPath) => {
    const absoluteRoot = dirname(manifestPath)
    return {
      relativeRoot: toRelativePosix(workspaceRoot, absoluteRoot),
      absoluteRoot,
      managerTool,
      manifestPath,
    }
  })
}

function toManifestPattern(pattern: string): string {
  return pattern.replace(/\/?$/, `/${JS_PACKAGE_MANIFEST}`)
}

function readPatternList(value: unknown, key: string, manifestPath: string): string[] {
  if (value === null || typeof value !== "object") return []
  const field = (value as Record<string, unknown>)[key]
  if (field === undefined || field === null) return []
  if (!Array.isArray(field)) {
    throw malformedPatternList(manifestPath, key, `it is ${describeJsonType(field)}, not a list`)
  }
  for (const [index, element] of field.entries()) {
    if (typeof element !== "string") {
      throw malformedPatternList(
        manifestPath,
        key,
        `entry ${index} is ${describeJsonType(element)}, not a string`,
      )
    }
  }
  return [...field]
}

function malformedPatternList(manifestPath: string, key: string, fault: string): CoreError {
  return new CoreError(
    `"${key}" in ${manifestPath} must be a list of package patterns, but ${fault}. Every package it was meant to declare is missing from the workspace.`,
    { code: "workspace-manifest-malformed", value: manifestPath },
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err: unknown) {
    if (isVanishedFile(err)) return false
    throw err
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8")
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new CoreError(
      `Failed to parse JSON at ${path}`,
      { code: "workspace-manifest-malformed", value: path },
      { cause },
    )
  }
}

function toRelativePosix(root: string, target: string): string {
  const rel = relative(root, target)
  if (rel.length === 0) return "."
  const posixRel = sep === "/" ? rel : rel.split(sep).join(posix.sep)
  return toNfc(posixRel)
}

/** Re-export so callers (component.ts) can list the directories without redoing detection. */
export type { WorkspaceManager }

/** Cheap helper for callers that only want to know whether a directory exists. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch (err: unknown) {
    if (isVanishedFile(err)) return false
    throw err
  }
}

/** Read a directory; returns [] on ENOENT so callers do not have to wrap. */
export async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (err: unknown) {
    if (isVanishedFile(err)) return []
    throw err
  }
}
