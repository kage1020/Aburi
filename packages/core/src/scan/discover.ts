import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { SkippedFile as SkippedFileRecord } from "@aburi/types"
import { glob } from "tinyglobby"
import { CoreError } from "../errors"
import { symbolIdSeparatorsIn, toDocumentPath } from "../id"

/**
 * Category A drop patterns from drop-list.md §3.1. Kept here rather than embedded in a
 * scan-caller because file discovery is the only place they apply — they are ignore
 * globs, not IR-visible drops.
 */
const CORE_IGNORE_PATTERNS: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.output/**",
  "**/coverage/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.generated.*",
  "**/*.gen.*",
  "**/*.g.ts",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/.venv/**",
  "**/venv/**",
  "**/site-packages/**",
  "**/vendor/**",
  "**/Cargo.lock",
  "**/go.sum",
]

/** Default file size cap when `config.maxFileSizeBytes` is not set (2 MiB per config.v1 schema). */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

export interface DiscoverOptions {
  /**
   * Workspace root absolute path. All returned file paths are POSIX-relative to this
   * root — matches the `SourceRange.file` contract in ir-schema §12 (SourceRange).
   */
  workspaceRoot: string
  /**
   * Additional glob patterns (from `config.ignore`) folded into the core ignore set.
   * POSIX, workspace-root relative per config.v1 schema.
   */
  ignore?: readonly string[]
  /**
   * Language-plugin-supplied file-drop globs (e.g. `["**\/*.d.ts"]` from
   * `lang-typescript`). Merged into the ignore set at discovery time so drop patterns
   * added by a plugin do not need to run through file-level IR machinery.
   */
  langDropPatterns?: readonly string[]
  /**
   * When true (the default), `.gitignore` in the workspace root is read and its
   * patterns are folded into the ignore set. Matches `--no-respect-gitignore` CLI
   * inversion.
   */
  respectGitignore?: boolean
  /**
   * Cap in bytes. Files larger than this are dropped from discovery with a
   * `ScanResult.skipped` entry so the WASM parsers do not have to fight oversized inputs.
   */
  maxFileSizeBytes?: number
  /**
   * File extensions the caller can handle — only files whose extension is registered by
   * a loaded language plugin are returned. When omitted, every file matched by the glob
   * survives (used primarily by tests).
   */
  languageExtensions?: readonly string[]
}

export interface DiscoveredFile {
  /** POSIX path relative to `workspaceRoot`. */
  path: string
  /** File size in bytes. */
  size: number
}

/**
 * A file that produced no Symbols. `over-size` and `unreadable` are decided here during
 * discovery, as is the half of `unroutable` that is about the file's name; the other half of
 * `unroutable`, and `parse-failed`, `parse-timeout` and `extraction-failed`, are decided by the
 * scan orchestrator afterwards and merged into the same list, because from the reader's side
 * they answer the same question — why is this file missing from the IR?
 *
 * The list is exhaustive over the files the scan *gave up on*, which is what lets
 * `stats.parsedFiles` be derived from its length rather than from a counter per reason. A
 * file that parses cleanly and declares nothing is not one of those: it is absent from the
 * list and counted as parsed, which is correct.
 *
 * `unreadable` is the one reason both sides can raise: discovery hits it when it cannot stat
 * or read a candidate, and the orchestrator hits it when the read it does just before
 * extraction fails.
 *
 * The reason union comes from the IR schema rather than being spelled again here, because
 * the two must agree: `stats.skippedFiles[]` is this list projected into the Document, and a
 * reason that existed on only one side would be a member the reader of a diff cannot name.
 * `detail` is what the scan adds and the Document does not take — see the schema for why.
 */
export interface SkippedFile extends SkippedFileRecord {
  detail?: string
}

export interface DiscoverResult {
  files: DiscoveredFile[]
  skipped: SkippedFile[]
}

/**
 * Walk the workspace and yield the files that survive Category A drop rules. The
 * returned paths are POSIX + workspace-relative; the `size` field lets downstream
 * pipeline stages plan without a second `stat` round-trip.
 *
 * Ordering: `files` is sorted by path (asciibetical) so callers get a deterministic
 * scan even when the filesystem returns entries in a race-dependent order. This is what
 * lets `stats.totalFiles` and IR content stay stable across runs.
 */
export async function discoverFiles(options: DiscoverOptions): Promise<DiscoverResult> {
  const workspaceRoot = resolve(options.workspaceRoot)
  const maxSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
  const respectGitignore = options.respectGitignore ?? true

  const ignore = [
    ...CORE_IGNORE_PATTERNS,
    ...(options.ignore ?? []),
    ...(options.langDropPatterns ?? []),
  ]

  if (respectGitignore) {
    const gitignorePatterns = await readGitignore(workspaceRoot)
    ignore.push(...gitignorePatterns)
  }

  const matches = await glob(["**/*"], {
    cwd: workspaceRoot,
    ignore,
    onlyFiles: true,
    dot: false,
    absolute: false,
  })

  const extensions = new Set(options.languageExtensions ?? [])
  const files: DiscoveredFile[] = []
  const skipped: SkippedFile[] = []

  for (const rawPath of matches) {
    const posix = toDocumentPath(rawPath)
    if (extensions.size > 0 && !hasKnownExtension(posix, extensions)) continue

    // After the extension filter, so a file no plugin claims is filtered on that alone. A
    // `notes:1.txt` in a TypeScript workspace was never a candidate, and recording it would be
    // an incident about a file the scan was never going to read.
    //
    // Recorded rather than thrown on, which is what this used to do from inside the path
    // normalizer. `:` and `#` are legal POSIX filename characters and are refused by the id
    // grammar alone, so one of them anywhere in the tree ended the whole walk — six lines below,
    // a file that cannot even be `stat`ed is recorded and the walk continues. The path is
    // recordable because `stats.skippedFiles[].path` is held to the shared rule, so the Document
    // names a file no Symbol in it could ever have named.
    const separators = symbolIdSeparatorsIn(posix)
    if (separators.length > 0) {
      skipped.push({
        path: posix,
        reason: "unroutable",
        detail: `its name contains ${separators.map((s) => `"${s}"`).join(" and ")}, which a Symbol id is split on, so nothing declared in it could be given an id`,
      })
      continue
    }

    const absolute = resolve(workspaceRoot, posix)
    let size: number
    try {
      const info = await stat(absolute)
      size = info.size
    } catch (error) {
      skipped.push({ path: posix, reason: "unreadable", detail: (error as Error).message })
      continue
    }

    if (size > maxSize) {
      skipped.push({ path: posix, reason: "over-size", detail: `${size} > ${maxSize}` })
      continue
    }

    files.push({ path: posix, size })
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return { files, skipped }
}

function hasKnownExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return false
  return extensions.has(path.slice(dot).toLowerCase())
}

async function readGitignore(workspaceRoot: string): Promise<string[]> {
  const path = resolve(workspaceRoot, ".gitignore")
  try {
    const content = await readFile(path, "utf8")
    return parseGitignore(content)
  } catch (error) {
    // Missing file is fine — most workspaces do not have a .gitignore at the root
    // level and gracefully fall back to just the core ignore patterns. Any other
    // failure (permission denied, I/O error, symlink loop) is a real problem the
    // caller needs to see instead of a silently-empty pattern list.
    if (isEnoent(error)) return []
    throw new CoreError(
      `.gitignore at "${path}" exists but could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { code: "scan-gitignore-unreadable", value: path },
      { cause: error },
    )
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  )
}

/**
 * Minimal `.gitignore` parser — enough to translate line-oriented patterns into globs
 * `tinyglobby` understands. Negation (`!pattern`) is preserved so an explicit
 * un-ignore in the file survives.
 */
function parseGitignore(content: string): string[] {
  const patterns: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("!")) {
      patterns.push(`!${normalizePattern(trimmed.slice(1))}`)
    } else {
      patterns.push(normalizePattern(trimmed))
    }
  }
  return patterns
}

function normalizePattern(pattern: string): string {
  // Anchored pattern (`/foo`) matches at the root only; the equivalent glob is just
  // stripping the leading slash. Trailing slash marks a directory match — glob it as
  // `<name>/**` so the entire subtree is included.
  let p = pattern.startsWith("/") ? pattern.slice(1) : `**/${pattern}`
  if (p.endsWith("/")) p = `${p}**`
  return p
}
