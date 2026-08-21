import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import type { WorkspaceManager } from "@aburi/types"
import { glob } from "tinyglobby"
import { parse as parseYaml } from "yaml"
import { CoreError } from "./errors"
import { posixWorkspaceRelativeViolation } from "./id"

/**
 * Filenames whose presence at any directory ancestor identifies a workspace root. The
 * outermost match wins (see detectWorkspaceRoot's contract): when both a sub-project and a
 * monorepo parent carry markers, the monorepo root is the one the IR must describe.
 */
const ROOT_MARKERS = [
  ".git",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "go.work",
  ".aburi-workspace",
] as const

/**
 * Files whose presence is a marker only when their content satisfies an extra predicate
 * (e.g. `package.json` is a marker only when it carries a `workspaces` field).
 */
const CONDITIONAL_ROOT_MARKERS = ["package.json", "Cargo.toml", "pyproject.toml"] as const

export interface DetectWorkspaceRootOptions {
  /**
   * Starting directory. The detector walks parent directories upward and remembers the
   * outermost marker hit. Defaults to `process.cwd()`. Relative paths are resolved against
   * the current working directory.
   */
  cwd?: string
}

/**
 * Walk upward from `cwd` and return the absolute path of the outermost directory that
 * carries a workspace marker. Outermost wins so a sub-project's `package.json` does not
 * shadow the monorepo's `.git` / `pnpm-workspace.yaml`.
 *
 * Throws CoreError "workspace-root-not-found" only when no marker exists between cwd and
 * the filesystem root — callers fall back to "treat cwd as a single-project workspace" in
 * that branch rather than aborting.
 */
export async function detectWorkspaceRoot(
  options: DetectWorkspaceRootOptions = {},
): Promise<string> {
  const startRaw = options.cwd ?? process.cwd()
  const start = isAbsolute(startRaw) ? startRaw : resolve(process.cwd(), startRaw)

  let dir = start
  let outermost: string | null = null
  while (true) {
    if (await directoryHasMarker(dir)) outermost = dir
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
  return outermost
}

async function directoryHasMarker(dir: string): Promise<boolean> {
  for (const name of ROOT_MARKERS) {
    if (await pathExists(join(dir, name))) return true
  }
  for (const name of CONDITIONAL_ROOT_MARKERS) {
    const path = join(dir, name)
    if (!(await pathExists(path))) continue
    if (await fileSatisfiesWorkspacePredicate(name, path)) return true
  }
  return false
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

/**
 * Lightweight TOML probe: we only need to know whether `[workspace]` or `[tool.uv.workspace]` /
 * `[tool.hatch.workspaces]` / `[tool.poetry]` headers exist. Avoiding a full TOML parser
 * dependency here keeps the surface narrow; the language plugins will bring proper
 * TOML parsing when they ship.
 */
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
  /**
   * Resolved per-manager workspace candidate directories (workspace-root-relative POSIX
   * paths). Component autodetect consumes this to materialize components without re-globbing.
   */
  workspaces: WorkspaceCandidate[]
}

export interface WorkspaceCandidate {
  /** Workspace-root-relative POSIX path of the candidate directory. */
  relativeRoot: string
  /** Absolute path of the candidate directory. */
  absoluteRoot: string
  /** Tool that produced this candidate (the same path may appear once per tool). */
  managerTool: string
  /** Resolved manifest path (e.g. `package.json`). Null if the candidate has no manifest yet. */
  manifestPath: string | null
}

/**
 * Resolve every JS/TS workspace manager the detectors currently recognize: pnpm,
 * npm/yarn/bun (via `package.json#workspaces`), turbo (as a hint), and nx (via project.json
 * presence). Each manager's roots are recorded once on `managers[]` (workspace-relative
 * POSIX paths), and every candidate directory is materialized on `workspaces[]` for
 * downstream Component synthesis.
 */
export async function detectManagers(workspaceRoot: string): Promise<DetectManagersResult> {
  const managers: WorkspaceManager[] = []
  const workspaces: WorkspaceCandidate[] = []
  const seen = new Set<string>()

  await Promise.all([
    detectPnpm(workspaceRoot).then((r) => mergeManager(r, managers, workspaces, seen)),
    detectPackageJsonWorkspaces(workspaceRoot).then((rs) => {
      for (const r of rs) mergeManager(r, managers, workspaces, seen)
    }),
    detectTurbo(workspaceRoot).then((r) => mergeManager(r, managers, workspaces, seen)),
    detectNx(workspaceRoot).then((r) => mergeManager(r, managers, workspaces, seen)),
  ])

  managers.sort((a, b) => compareString(a.tool, b.tool))
  for (const m of managers) m.roots.sort(compareString)
  workspaces.sort(
    (a, b) =>
      compareString(a.relativeRoot, b.relativeRoot) || compareString(a.managerTool, b.managerTool),
  )
  return { managers, workspaces }
}

interface ManagerScan {
  tool: string
  candidates: WorkspaceCandidate[]
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

/**
 * Refuse a declared package that sits outside the workspace root.
 *
 * `tinyglobby` honours an ascending pattern and returns matches above `cwd`, so a manifest
 * declaring `packages: ['../shared/*']` produces candidates whose relative root starts
 * `..`. Two things are then true at once, and neither is something to record: the IR cannot
 * express such a root (`workspace.root` anchors every path in the Document, and integrity
 * invariant #10 refuses one that ascends past it), and the file walk never opens those
 * directories anyway, because it globs `**` under the workspace root.
 *
 * Failing is the honest outcome rather than dropping the candidate. Silently continuing
 * would produce a Document that omits packages the user declared, with nothing anywhere
 * saying so; `detectManagers` already refuses a manifest it cannot parse, and this is the
 * same class of problem in the same file. The message names the tool and the offending
 * root, and the CLI reports it against the workspace rather than as an internal failure.
 */
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
  const patterns = readStringArray(parsed, "packages")
  const candidates = await resolveGlobsToCandidates(root, patterns, "pnpm")
  return { tool: "pnpm", candidates }
}

async function detectPackageJsonWorkspaces(root: string): Promise<ManagerScan[]> {
  const manifestPath = join(root, "package.json")
  if (!(await pathExists(manifestPath))) return []
  const parsed = await readJson(manifestPath)
  const patterns = extractWorkspacePatterns(parsed)
  if (patterns.length === 0) return []
  const tool = detectJsPackageManagerTool(root)
  const candidates = await resolveGlobsToCandidates(root, patterns, await tool)
  return [{ tool: await tool, candidates }]
}

function extractWorkspacePatterns(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object") return []
  const ws = (parsed as { workspaces?: unknown }).workspaces
  if (Array.isArray(ws)) return ws.filter((v): v is string => typeof v === "string")
  if (ws !== null && typeof ws === "object") {
    const packages = (ws as { packages?: unknown }).packages
    if (Array.isArray(packages)) return packages.filter((v): v is string => typeof v === "string")
  }
  return []
}

/**
 * Pick the most specific lockfile present (pnpm > yarn > bun > npm). The IR's manager id
 * mirrors the lockfile because `pnpm-lock.yaml` proves pnpm, even when `package.json#workspaces`
 * also matches npm's vocabulary.
 */
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
  // turbo.json does not declare workspaces itself; it is a co-marker that signals "the
  // real workspace patterns live in pnpm-workspace.yaml or package.json#workspaces".
  // Emit a manager entry with empty roots so the IR records the tool's presence.
  return { tool: "turbo", candidates: [] }
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
  return { tool: "nx", candidates }
}

async function resolveGlobsToCandidates(
  workspaceRoot: string,
  patterns: readonly string[],
  managerTool: string,
): Promise<WorkspaceCandidate[]> {
  if (patterns.length === 0) return []
  const dirs = await glob(patterns, {
    cwd: workspaceRoot,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyDirectories: true,
    absolute: true,
    deep: 10,
  })
  const candidates: WorkspaceCandidate[] = []
  for (const absoluteRoot of dirs) {
    const manifestPath = join(absoluteRoot, "package.json")
    const has = await pathExists(manifestPath)
    candidates.push({
      relativeRoot: toRelativePosix(workspaceRoot, absoluteRoot),
      absoluteRoot,
      managerTool,
      manifestPath: has ? manifestPath : null,
    })
  }
  return candidates
}

function readStringArray(value: unknown, key: string): string[] {
  if (value === null || typeof value !== "object") return []
  const field = (value as Record<string, unknown>)[key]
  if (!Array.isArray(field)) return []
  return field.filter((v): v is string => typeof v === "string")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err: unknown) {
    if (isBenignFsError(err)) return false
    throw err
  }
}

function isBenignFsError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return code === "ENOENT" || code === "ENOTDIR"
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

/**
 * Express `target` as a workspace-relative POSIX path, in the same spelling
 * `toDocumentPath` gives the file paths that sit beside it in the IR.
 *
 * The NFC step is the §1.2 entry point for roots (ir-schema.md): a root left in whatever
 * spelling the filesystem returned would disagree with a `symbols[].source.file` naming
 * the same directory, which is normalized at its own entry point.
 *
 * A `..` result is possible and is not normalized away: glob patterns may ascend, and a
 * directory above the workspace root genuinely is outside it. `mergeManager` drops those.
 */
function toRelativePosix(root: string, target: string): string {
  const rel = relative(root, target)
  if (rel.length === 0) return "."
  const posixRel = sep === "/" ? rel : rel.split(sep).join(posix.sep)
  return posixRel.normalize("NFC")
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Re-export so callers (component.ts) can list the directories without redoing detection. */
export type { WorkspaceManager }

/** Cheap helper for callers that only want to know whether a directory exists. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch (err: unknown) {
    if (isBenignFsError(err)) return false
    throw err
  }
}

/** Read a directory; returns [] on ENOENT so callers do not have to wrap. */
export async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (err: unknown) {
    if (isBenignFsError(err)) return []
    throw err
  }
}
