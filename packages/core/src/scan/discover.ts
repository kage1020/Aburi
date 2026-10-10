import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { SkippedFile as SkippedFileRecord } from "@aburi/types"
import { glob } from "tinyglobby"
import { toNfc } from "../codepoints"
import { backslashSite, symbolIdSeparatorSite, toDocumentPath } from "../id"
import { compareBy } from "../order"
import { describeThrown, isVanishedFile } from "./faults"
import { openGitignoreTree } from "./gitignore"
import { fileExtension } from "./route"

export const CORE_IGNORE_PATTERNS: readonly string[] = [
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

export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

export interface DiscoverOptions {
  workspaceRoot: string
  ignore?: readonly string[]
  langDropPatterns?: readonly string[]
  respectGitignore?: boolean
  maxFileSizeBytes?: number
  languageExtensions?: readonly string[]
}

export interface DiscoveredFile {
  path: string
  fsPath: string
  size: number
}

export interface SkippedFile extends SkippedFileRecord {
  detail?: string
}

export type UnrepresentableFile = UnnameableFile | CollidingFile

interface UnrepresentableBase {
  fsPath: string
}

export interface UnnameableFile extends UnrepresentableBase {
  reason: "unspellable-name"
  unnameablePrefix: string
}

export interface CollidingFile extends UnrepresentableBase {
  reason: "colliding-spelling"
  documentPath: string
}

export interface DiscoverResult {
  files: DiscoveredFile[]
  skipped: SkippedFile[]
  unrepresentableFiles: UnrepresentableFile[]
}

export async function discoverFiles(options: DiscoverOptions): Promise<DiscoverResult> {
  const workspaceRoot = resolve(options.workspaceRoot)
  const maxSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
  const respectGitignore = options.respectGitignore ?? true

  const dropGlobs = [
    ...CORE_IGNORE_PATTERNS,
    ...(options.ignore ?? []),
    ...(options.langDropPatterns ?? []),
  ]

  const gitignore = respectGitignore ? openGitignoreTree(workspaceRoot) : null

  const matches = await glob(["**/*"], {
    cwd: workspaceRoot,
    ignore: dropGlobs,
    onlyFiles: true,
    dot: false,
    absolute: false,
  })

  const extensions = new Set((options.languageExtensions ?? []).map(toNfc))
  const files: DiscoveredFile[] = []
  const skipped: SkippedFile[] = []
  const unrepresentableFiles: UnrepresentableFile[] = []
  const claimants = new Map<string, string[]>()

  for (const rawPath of matches) {
    if (extensions.size > 0 && !hasKnownExtension(rawPath, extensions)) continue

    if (gitignore !== null && (await gitignore.ignores(rawPath))) continue

    const unnameable = backslashSite(rawPath)
    if (unnameable !== null) {
      unrepresentableFiles.push({
        fsPath: rawPath,
        reason: "unspellable-name",
        unnameablePrefix: unnameable.prefix,
      })
      continue
    }

    const documentPath = toDocumentPath(rawPath)

    const claimantsByPath = claimants.get(documentPath)
    if (claimantsByPath === undefined) claimants.set(documentPath, [rawPath])
    else claimantsByPath.push(rawPath)

    const separatorSite = symbolIdSeparatorSite(documentPath)
    if (separatorSite !== null) {
      const quotedSeparators = separatorSite.separators
        .map((separator) => `"${separator}"`)
        .join(" and ")
      skipped.push({
        path: documentPath,
        reason: "unroutable",
        detail: `its path segment "${separatorSite.segment}" contains ${quotedSeparators}, which a Symbol id is split on, so nothing declared in this file could be given an id`,
      })
      continue
    }

    // A filesystem that stores names as given does not answer to the normalized spelling.
    const absolute = resolve(workspaceRoot, rawPath)
    let size: number
    try {
      const info = await stat(absolute)
      size = info.size
    } catch (error) {
      if (!isVanishedFile(error)) throw error
      skipped.push({ path: documentPath, reason: "unreadable", detail: describeThrown(error) })
      continue
    }

    if (size > maxSize) {
      skipped.push({ path: documentPath, reason: "over-size", detail: `${size} > ${maxSize}` })
      continue
    }

    files.push({ path: documentPath, fsPath: rawPath, size })
  }

  withdrawCollisions(claimants, files, skipped, unrepresentableFiles)

  files.sort(compareBy((file) => file.path))
  skipped.sort(compareBy((file) => file.path))
  unrepresentableFiles.sort(compareBy((file) => file.fsPath))

  return { files, skipped, unrepresentableFiles }
}

function withdrawCollisions(
  claimants: ReadonlyMap<string, readonly string[]>,
  files: DiscoveredFile[],
  skipped: SkippedFile[],
  unrepresentableFiles: UnrepresentableFile[],
): void {
  const collided = new Set<string>()
  for (const [documentPath, spellings] of claimants) {
    if (spellings.length < 2) continue
    collided.add(documentPath)
    for (const fsPath of spellings) {
      unrepresentableFiles.push({ fsPath, reason: "colliding-spelling", documentPath })
    }
  }
  if (collided.size === 0) return
  for (const list of [files, skipped]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]
      if (entry !== undefined && collided.has(entry.path)) list.splice(i, 1)
    }
  }
}

function hasKnownExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const extension = fileExtension(path)
  return extension !== null && extensions.has(extension)
}
