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
  /**
   * Managers whose manifest declared package patterns and resolved none of them.
   *
   * Reported rather than warned about, because detection has no sink of its own and its two
   * CLI callers each have one. `detectComponents` drops the field deliberately: `aburi init`
   * reaches it through that function and reads `unresolved` from its own `detectManagers`
   * call, so carrying it through a second return type would be a second copy of one answer.
   *
   * It is not the same as an empty `managers[].roots`: turbo emits that deliberately as a
   * co-marker, and a manifest that declared no patterns at all is asking for the workspace
   * root alone — only a declaration that resolved to nothing means the packages the user
   * named are missing from the Document.
   */
  unresolved: UnresolvedDeclaration[]
}

/** A manifest's package patterns, none of which named a package. */
export interface UnresolvedDeclaration {
  /** The tool whose manifest declared them, as spelled on `managers[].tool`. */
  tool: string
  /**
   * The manifest that declared them, workspace-root-relative and POSIX.
   *
   * `tool` does not identify it: `detectJsPackageManagerTool` answers "pnpm" for a
   * `package.json#workspaces` whenever a `pnpm-lock.yaml` is present, so a repository that
   * moved to pnpm and left `workspaces` behind has two dead manifests under one tool name.
   * This is what a reader opens, and what orders the two.
   */
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
  /**
   * Absolute path of the manifest that made this directory a package (`package.json`,
   * `project.json`). Every detector finds candidates by finding manifests, so a candidate
   * without one is not a shape this type has.
   */
  manifestPath: string
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
    detectPackageJsonWorkspaces(workspaceRoot).then((rs) => {
      for (const r of rs) merge(r)
    }),
    detectTurbo(workspaceRoot).then(merge),
    detectNx(workspaceRoot).then(merge),
  ])

  managers.sort((a, b) => compareString(a.tool, b.tool))
  for (const m of managers) m.roots.sort(compareString)
  workspaces.sort(
    (a, b) =>
      compareString(a.relativeRoot, b.relativeRoot) || compareString(a.managerTool, b.managerTool),
  )
  unresolved.sort(
    (a, b) => compareString(a.tool, b.tool) || compareString(a.manifestPath, b.manifestPath),
  )
  return { managers, workspaces, unresolved }
}

interface ManagerScan {
  tool: string
  candidates: WorkspaceCandidate[]
  /** Absolute path of the manifest this scan read. */
  manifestPath: string
  /**
   * Every string this manager's manifest lists as a package pattern. Empty when it lists none:
   * turbo and nx declare no patterns at all, and a `packages:` or `workspaces` field that is
   * absent yields none. A field that is present and is not a list of strings does not reach
   * here — `readPatternList` refuses it.
   */
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

/**
 * npm and yarn accept `workspaces` as a list or as `{ packages: [...] }`, so the object form
 * is unwrapped before the shared rule in `readPatternList` reads it.
 */
function extractWorkspacePatterns(parsed: unknown, manifestPath: string): string[] {
  if (parsed === null || typeof parsed !== "object") return []
  const ws = (parsed as { workspaces?: unknown }).workspaces
  if (ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
    return readPatternList(ws, "packages", manifestPath)
  }
  return readPatternList(parsed, "workspaces", manifestPath)
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

/**
 * Resolve a manager's declared package patterns into candidate directories.
 *
 * Matched against the manifest rather than against the directory, because a directory pattern
 * is not a directory to tinyglobby: `expandDirectories` widens one that names a directory into
 * that directory's whole subtree, so `.` reaches everything and `tools/build` swallows
 * `tools/build/nested`. Against the manifest, a pattern names what it says.
 *
 * `expandDirectories` is off here for the residue of the same behaviour: a directory literally
 * named `package.json` would be widened into the files beneath it, and each of those would
 * name that directory as a package.
 */
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

/**
 * Append the manifest to the directory the pattern names, replacing a trailing slash — so `.`
 * and `./` alike become `./package.json`, the root's own manifest.
 *
 * A negation keeps its `!` and needs no special case: a directory is a candidate only through
 * its manifest, so excluding the manifest excludes the directory. An empty pattern is dropped
 * before this — it would become `/package.json`, which names the filesystem root.
 */
function toManifestPattern(pattern: string): string {
  return pattern.replace(/\/?$/, `/${JS_PACKAGE_MANIFEST}`)
}

/**
 * The package patterns a manifest declares under `key`, or `[]` when it declares none.
 *
 * A field that is present and is not a list of strings is refused rather than filtered away.
 * `packages:` followed by `- tools/*:` is the most ordinary YAML slip there is — the trailing
 * colon makes the entry a map — and every such manifest declares packages, resolves none, and
 * lands on the single-project fallback describing the whole repository. Dropping the element
 * quietly is the silence this file reports everywhere else, one level further in; pnpm refuses
 * all three shapes itself (`Invalid package type - object`, `packages field is not an array`,
 * `Invalid package type - number`), so this is its reading rather than a stricter one.
 *
 * The remediation differs from a pattern that matched nothing — write it as a list of strings,
 * rather than fix the pattern — which is why it is a refusal and not another entry on
 * `unresolved`.
 */
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

/** How a value is named in a message about the JSON or YAML shape it came from. */
function describeJsonType(value: unknown): string {
  if (Array.isArray(value)) return "a list"
  if (value === null) return "null"
  const type = typeof value
  return `${type === "object" ? "an" : "a"} ${type}`
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
 * The one place a separator is converted, and the reason the conversion is guarded on `sep`
 * rather than applied to every backslash: `relative` hands back a native path, and only where
 * the platform separator *is* a backslash does a backslash in it mean a separator. On POSIX it
 * is an ordinary filename character, and rewriting it renames the directory rather than
 * describing it. Everything that takes a path already in POSIX form — the file walk, from
 * `glob` — hands it to `toDocumentPath` unconverted, which is what lets the shared rule refuse
 * the character instead of spending it.
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
