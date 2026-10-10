import { open, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { CoreError } from "./errors"
import { isVanishedFile } from "./scan/faults"
import { pathExists, readJson } from "./workspace-fs"

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

interface MarkerFailure {
  dir: string
  cause: unknown
}

interface MarkerProbe {
  marker: RootMarker | null
  /** `null` when every probe answered. */
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
  const text = await readFile(path, "utf8")
  return /^\s*\[workspace\]/m.test(text) || /^\s*\[workspace\.members\]/m.test(text)
}

async function pyprojectDeclaresWorkspace(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8")
  return (
    /^\s*\[tool\.uv\.workspace\]/m.test(text) ||
    /^\s*\[tool\.hatch\.workspaces\]/m.test(text) ||
    /^\s*\[tool\.poetry\]/m.test(text)
  )
}
