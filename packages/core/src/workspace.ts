import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path"
import type { WorkspaceManager } from "@aburi/types"
import { parse as parseYaml } from "yaml"
import { toNfc } from "./codepoints"
import { CoreError } from "./errors"
import { posixWorkspaceRelativeViolation, type UnnameableSite, unnameableSite } from "./id"
import { compareBy, compareCodeUnit } from "./order"
import { describeJsonType } from "./scan/faults"
import { type GitignoreTree, openGitignoreTree } from "./scan/gitignore"
import { walk } from "./scan/walk"
import { pathExists, readJson } from "./workspace-fs"

export interface DetectManagersResult {
  managers: WorkspaceManager[]
  workspaces: WorkspaceCandidate[]
  unresolved: UnresolvedDeclaration[]
  unnameableRoots: UnnameableRoot[]
}

/** A manifest's package patterns, none of which named a package. */
export interface UnresolvedDeclaration {
  /** The tool whose manifest declared them, as spelled on `managers[].tool`. */
  tool: string
  manifestPath: string
  /** Every string the manifest lists, including ones the resolver drops. */
  patterns: readonly string[]
}

export interface DetectManagersOptions {
  /**
   * Whether `.gitignore` is honoured, default `true`. The nx search honours it as nx does: a
   * `project.json` it excludes is no project, and a directory it excludes may go unlisted.
   * Declared package patterns never read it, as pnpm and npm do not.
   */
  respectGitignore?: boolean | undefined
}

/** A package directory no Document path can spell, left off `managers[].roots`. */
export interface UnnameableRoot {
  tool: string
  /** The manifest of the detector that found it, as on {@link UnresolvedDeclaration}. */
  manifestPath: string
  /** As spelled on disk, which is what a rename starts from. */
  relativeRoot: string
  reason: UnnameableSite["reason"]
  unnameablePrefix: string
}

export interface WorkspaceCandidate {
  /** Workspace-root-relative POSIX path of the candidate directory. */
  relativeRoot: string
  absoluteRoot: string
  /** Tool that produced this candidate (the same path may appear once per tool). */
  managerTool: string
  manifestPath: string
}

export async function detectManagers(
  workspaceRoot: string,
  options: DetectManagersOptions = {},
): Promise<DetectManagersResult> {
  const gitignore = (options.respectGitignore ?? true) ? openGitignoreTree(workspaceRoot) : null
  const managers: WorkspaceManager[] = []
  const workspaces: WorkspaceCandidate[] = []
  const unresolved: UnresolvedDeclaration[] = []
  const unnameableRoots: UnnameableRoot[] = []
  const seen = new Set<string>()
  const merge = (scan: ManagerScan | null): void => {
    if (scan === null) return
    const manifestPath = toRelativePosix(workspaceRoot, scan.manifestPath)
    for (const root of mergeManager(scan, workspaceRoot, managers, workspaces, seen)) {
      unnameableRoots.push({ tool: scan.tool, manifestPath, ...root })
    }
    if (scan.declaredPatterns.length > 0 && scan.candidates.length === 0) {
      unresolved.push({ tool: scan.tool, manifestPath, patterns: scan.declaredPatterns })
    }
  }

  const searches = await Promise.allSettled([
    detectPnpm(workspaceRoot).then(merge),
    detectPackageJsonWorkspaces(workspaceRoot).then((managerScans) => {
      for (const managerScan of managerScans) merge(managerScan)
    }),
    detectTurbo(workspaceRoot).then(merge),
    detectNx(workspaceRoot, gitignore).then(merge),
  ])
  const failures = searches.flatMap((search) =>
    search.status === "rejected" ? [search.reason] : [],
  )
  if (failures.length > 0) throw firstFailure(failures)

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
  unnameableRoots.sort(
    (a, b) =>
      compareCodeUnit(a.relativeRoot, b.relativeRoot) ||
      compareCodeUnit(a.tool, b.tool) ||
      compareCodeUnit(a.manifestPath, b.manifestPath),
  )
  return { managers, workspaces, unresolved, unnameableRoots }
}

// The searches run at once, so which of them fails first is timing; what the run reports is not.
function firstFailure(failures: readonly unknown[]): unknown {
  const unread = failures
    .filter(
      (failure): failure is CoreError =>
        failure instanceof CoreError && failure.code === "scan-directory-unreadable",
    )
    .sort(compareBy((failure) => failure.value ?? ""))
  return unread[0] ?? failures[0]
}

interface ManagerScan {
  tool: string
  candidates: WorkspaceCandidate[]
  manifestPath: string
  declaredPatterns: readonly string[]
}

type UnnameableCandidate = Omit<UnnameableRoot, "tool" | "manifestPath">

/** Returns the candidates it leaves out because no Document path can name their directory. */
function mergeManager(
  scan: ManagerScan,
  workspaceRoot: string,
  managers: WorkspaceManager[],
  workspaces: WorkspaceCandidate[],
  seen: Set<string>,
): UnnameableCandidate[] {
  const roots = new Set<string>()
  const leftOut: UnnameableCandidate[] = []
  for (const candidate of scan.candidates) {
    const unnameable = unnameableCandidate(workspaceRoot, candidate)
    if (unnameable !== null) {
      leftOut.push(unnameable)
      continue
    }
    assertInsideWorkspace(candidate, scan.tool)
    roots.add(candidate.relativeRoot)
    const key = `${candidate.managerTool}\t${candidate.relativeRoot}`
    if (seen.has(key)) continue
    seen.add(key)
    workspaces.push(candidate)
  }
  managers.push({ tool: scan.tool, roots: [...roots] })
  return leftOut
}

// A root `relative` gives as absolute is on another Windows drive, and one holding `..` is above
// the workspace: both are outside it, whatever their names, and are refused as such.
function unnameableCandidate(
  workspaceRoot: string,
  candidate: WorkspaceCandidate,
): UnnameableCandidate | null {
  const relativeRoot = spelledRelativePosix(workspaceRoot, candidate.absoluteRoot)
  if (isAbsolute(relativeRoot) || relativeRoot.split("/").includes("..")) return null
  const site = unnameableSite(relativeRoot)
  if (site === null) return null
  return { relativeRoot, reason: site.reason, unnameablePrefix: site.prefix }
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
  const text = await readFile(manifestPath, "utf8")
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

async function detectNx(
  root: string,
  gitignore: GitignoreTree | null,
): Promise<ManagerScan | null> {
  const manifestPath = join(root, "nx.json")
  if (!(await pathExists(manifestPath))) return null
  const projectFiles = await walk(["**/project.json"], {
    cwd: root,
    // The directories nx's own file walk passes over, and `dist`.
    ignore: [
      "**/node_modules/**",
      "**/.nx/cache/**",
      "**/.nx/workspace-data/**",
      "**/.yarn/cache/**",
      "**/dist/**",
    ],
    onlyFiles: true,
    absolute: true,
    // Nx looks for projects in dot directories, and discovery scans them.
    dot: true,
    // Discovery does not walk through a link or into a nested checkout, so a project found there
    // would own no scanned file.
    followSymbolicLinks: false,
    skipNestedCheckouts: true,
    deep: 10,
    gitignore,
  })
  const candidates: WorkspaceCandidate[] = []
  for (const projectFile of projectFiles) {
    if (gitignore !== null && (await gitignore.ignores(toRelativePosix(root, projectFile))))
      continue
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

const JS_PACKAGE_MANIFEST = "package.json"

async function resolveDeclaredPackages(
  workspaceRoot: string,
  patterns: readonly string[],
  managerTool: string,
): Promise<WorkspaceCandidate[]> {
  const manifestPatterns = patterns.filter((p) => p.length > 0).map(toManifestPattern)
  // pnpm and npm resolve these same patterns this way: through links, into nested checkouts, and
  // with no wildcard matching a leading dot.
  const manifests = await walk(manifestPatterns, {
    cwd: workspaceRoot,
    ignore: ["**/node_modules/**"],
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: true,
    skipNestedCheckouts: false,
    expandDirectories: false,
    absolute: true,
    deep: 10,
    gitignore: null,
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

function toRelativePosix(root: string, target: string): string {
  return toNfc(spelledRelativePosix(root, target))
}

function spelledRelativePosix(root: string, target: string): string {
  const rel = relative(root, target)
  if (rel.length === 0) return "."
  return sep === "/" ? rel : rel.split(sep).join(posix.sep)
}
