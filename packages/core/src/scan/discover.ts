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

/**
 * Category A drop patterns from drop-list.md. They are ignore globs, not IR-visible drops.
 *
 * Exported because file discovery is no longer the only place they apply: component detection
 * counts file extensions to decide `Component.languages`, and it kept a shorter copy of part of
 * this list, so a directory this one drops was counted towards a label that reaches the IR.
 * Every entry is `**\/`-anchored, which is what lets one list serve two walks rooted at
 * different directories.
 *
 * The census keeps `.git` out with `dot: false` rather than a pattern, as discovery does — the
 * copy it replaced had `**\/.git\/**`, and this list does not.
 */
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

/** Default file size cap when `config.maxFileSizeBytes` is not set (2 MiB per config.v1 schema). */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

export interface DiscoverOptions {
  /**
   * Workspace root absolute path. All returned file paths are POSIX-relative to this
   * root — matches the `SourceRange.file` contract in ir-schema.md.
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
   * When true (the default), the `.gitignore` in **every** directory from the workspace root
   * down to a candidate's own decides whether it is returned, with the deepest file that has
   * an opinion winning — git's rule, and why `GitignoreSet` exists rather than one merged rule
   * list. `$GIT_DIR/info/exclude` and `core.excludesFile` are deliberately not read: they are
   * per-machine, and the Document must not depend on who ran the scan.
   *
   * See `readGitignores` for why the patterns are asked per candidate rather than folded into
   * the globs below. What `config.respectGitignore` sets, and what the CLI's
   * `--respect-gitignore` / `--no-respect-gitignore` pair overrides for one run.
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
  /**
   * POSIX path relative to `workspaceRoot`, in NFC: the spelling the Document holds
   * (ir-schema.md), and the one a Symbol id is built from.
   */
  path: string
  /**
   * The same file as the filesystem spells it, relative to `workspaceRoot`.
   *
   * Not decoration. `path` is normalized on the way into the Document, and a filesystem that
   * stores the name it was given — NTFS, ext4 — does not answer to the normalized one. Every site
   * that addresses the file takes this instead: the `stat` below, the `readFile` in the scan
   * orchestrator, and the `file://` URI the LSP pass tells a language server to open. The two
   * differ only for a name that was not already in NFC.
   */
  fsPath: string
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
 * The list is exhaustive over the files the scan gave up on *and can name*, which is what lets
 * `stats.parsedFiles` be derived from its length rather than from a counter per reason. A
 * file that parses cleanly and declares nothing is not one of those: it is absent from the
 * list and counted as parsed, which is correct.
 *
 * Two reasons are raised on both sides. `unreadable`: one condition decided by one predicate at
 * two calls — the candidate stopped being a file between the listing and the call that opened
 * it, which is discovery's `stat` and the orchestrator's `readFile` just before extraction. A
 * failure neither can put down to the tree changing ends the run instead of landing here.
 * `unroutable`: discovery hits it for a path no Symbol id could name, and the orchestrator hits
 * it when the router claims no plugin for the extension.
 *
 * The reason union comes from the IR schema rather than being spelled again here, because
 * the two must agree: `stats.skippedFiles[]` is this list projected into the Document, and a
 * reason that existed on only one side would be a member the reader of a diff cannot name.
 * `detail` is what the scan adds and the Document does not take — see the schema for why.
 */
export interface SkippedFile extends SkippedFileRecord {
  detail?: string
}

/**
 * A candidate file the Document has no way to name.
 *
 * Two things put a file here, and only what follows is true of both: it cannot be recorded on
 * `skipped`, because a skip entry is a path plus a reason and the path is what is missing or
 * ambiguous; and it cannot be counted without being recorded, because integrity #21 pins
 * `stats.skippedFiles`'s length to `totalFiles - parsedFiles`.
 *
 * So it leaves `totalFiles` entirely, the way a file no plugin claims does, and is carried here
 * instead — where the CLI reports it and gates the exit code on it, so the file is lost from the
 * Document without being lost from the run. Each arm says what it is and what fixes it.
 */
export type UnrepresentableFile = UnnameableFile | CollidingFile

interface UnrepresentableBase {
  /**
   * The path as the filesystem spells it. Named apart from `SkippedFile.path` because it is
   * not the same kind of value: that one is a validated, NFC Document path, and this one is
   * deliberately neither — the reader has to go and rename this exact file, so it is spelled
   * the way the filesystem does.
   */
  fsPath: string
}

/**
 * A file whose name holds a character no Document path can spell.
 *
 * A backslash is legal on a POSIX filesystem and has no spelling in a Document path: `/` is the
 * only separator one has, so any way of writing the name down reads as a directory boundary.
 * That is what separates it from a name holding `:` or `#`, which the id grammar refuses while
 * the shared path rule admits — those files are recorded on `skipped` by path, and this one
 * cannot be.
 */
export interface UnnameableFile extends UnrepresentableBase {
  reason: "unspellable-name"
  /**
   * The shortest prefix of `fsPath` that already cannot be named: the path up to and including
   * the first segment whose own name holds a backslash. That is the one rename that fixes it,
   * and every file under a directory with such a name shares it.
   */
  unnameablePrefix: string
}

/**
 * A file whose name a Document path can spell, but not apart from another file's.
 *
 * Two names differing only in Unicode normalization are one path once normalized, and
 * ir-schema.md requires the normalization: a Document that held both spellings would sort
 * them on opposite sides of the alphabet and give one construct two Symbol ids. So the
 * Document has exactly one name for two files, which is no name at all.
 *
 * Every claimant is withdrawn rather than one being kept. A rule granting the path to the
 * NFC-spelled claimant is partial — two different decomposed spellings can normalize to one
 * composed path with no NFC claimant among them — and it is the group that is at fault rather
 * than any member of it, the same reading a backslash in a directory name gets.
 *
 * A group is two or more: three spellings of one name is an ordinary case for a script that
 * emitted the same filename through different normalizers, and nothing here caps it at two.
 */
export interface CollidingFile extends UnrepresentableBase {
  reason: "colliding-spelling"
  /** The one Document path every claimant normalizes to. */
  documentPath: string
}

export interface DiscoverResult {
  files: DiscoveredFile[]
  skipped: SkippedFile[]
  unrepresentableFiles: UnrepresentableFile[]
}

/**
 * Walk the workspace and yield the files that survive Category A drop rules. The
 * returned paths are POSIX + workspace-relative; the `size` field lets downstream
 * pipeline stages plan without a second `stat` round-trip.
 *
 * Ordering: all three lists are sorted by path (asciibetical) so callers get a deterministic
 * scan even when the filesystem returns entries in a race-dependent order. This is what
 * lets `stats.totalFiles` and IR content stay stable across runs — and, for the third list,
 * what makes the paragraph the CLI builds from it the same paragraph on every run.
 */
export async function discoverFiles(options: DiscoverOptions): Promise<DiscoverResult> {
  const workspaceRoot = resolve(options.workspaceRoot)
  const maxSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
  const respectGitignore = options.respectGitignore ?? true

  // Globs, and only globs. `.gitignore` is not in here: see `openGitignoreTree` for why the
  // walk is not the place its patterns can be applied. Nor are these handed to it — a rule file
  // is opened by descending to it, and a directory these dropped is a directory no candidate
  // comes from, so the descent never arrives.
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
    // `tinyglobby` returns `/` as the separator on every platform (it hands `fdir` a
    // `pathSeparator: "/"`), so a backslash in this string is part of a filename. That is the
    // dependency's behaviour rather than its documented contract, so a test pins it.
    if (extensions.size > 0 && !hasKnownExtension(rawPath, extensions)) continue

    // Above every arm that *records* something: a `.gitignore`d file was never a candidate, so
    // it takes no path, moves no count, and leaves no incident. Asked with `rawPath` because
    // git matches what the filesystem stores; the matcher accepts every path `glob({ absolute:
    // false })` returns, dot-prefixed and backslash-holding names included.
    if (gitignore !== null && (await gitignore.ignores(rawPath))) continue

    // Before `toDocumentPath`, which refuses the character, and after the extension filter so
    // a `notes\1.txt` in a TypeScript workspace is never an incident. Not on `skipped`: see
    // `UnrepresentableFile` for why there is no path to record it under. `toDocumentPath`'s
    // own throws (empty, absolute, `.`/`..`) are unreachable from what `glob` returns.
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

    // Every candidate that got a Document path, recorded the instant it has one and before any
    // arm can end the iteration: a collision has to be decided over every list a candidate can
    // land in (two spellings on the skip list break invariant #21; one there and one on
    // `symbols[].source.file` is the contradiction `buildDiff` reads as a deletion). Above
    // `symbolIdSeparatorSite` because that check reads `documentPath` alone and would give
    // both spellings the same verdict.
    const claimantsByPath = claimants.get(documentPath)
    if (claimantsByPath === undefined) claimants.set(documentPath, [rawPath])
    else claimantsByPath.push(rawPath)

    // After the extension filter, so a file no plugin claims is filtered on that alone. A
    // `notes:1.txt` in a TypeScript workspace was never a candidate, and recording it would be
    // an incident about a file the scan was never going to read.
    //
    // Recorded rather than thrown on, which is what this used to do from inside the path
    // normalizer. `:` and `#` are legal POSIX filename characters and are refused by the id
    // grammar alone, so one of them anywhere in the tree ended the whole walk — while a file
    // the tree stopped holding is recorded further down this same loop and the walk
    // continues. The path is recordable because `stats.skippedFiles[].path` is held to the
    // shared rule, so the Document names a file no Symbol in it could ever have named.
    //
    // The segment is the subject, not the file. A separator in a directory name disqualifies
    // every file beneath it, and each of those filenames is innocent — `src/v#1/util.ts` is
    // fixed by renaming `v#1`, and a line blaming `util.ts` sends the reader to rename the
    // wrong thing. When the basename is the offender the two coincide.
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

    // `rawPath`, not `documentPath` — see `DiscoveredFile.fsPath`.
    const absolute = resolve(workspaceRoot, rawPath)
    let size: number
    try {
      const info = await stat(absolute)
      size = info.size
    } catch (error) {
      // The same decision the orchestrator makes about the `readFile` one stage later, out of
      // the same predicate. Recording a permission failure or an exhausted descriptor table
      // here left a smaller Document behind and exited `0`, while the identical errno on the
      // identical machine ended the run if it happened to land on the read instead.
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

/**
 * Take every candidate whose Document path another candidate also claims out of both lists.
 *
 * Left in, the group is not a degraded result but a broken run: two `DiscoveredFile`s with one
 * path make the pipeline read two different files — each by its own `fsPath` — and mint one
 * Symbol id for both, which invariant #1 refuses, ending the scan on a message about ids that
 * names neither filename. Two on the skip list break #21's "no path appears twice" the same way.
 *
 * They leave `totalFiles` with the rest of `unrepresentableFiles`, for the reason that list
 * exists: the Document cannot name them, so it cannot count them either without the census
 * claiming a file it has no entry for.
 */
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

/** Both sides in NFC: this reads the filesystem's spelling, which may arrive decomposed. */
function hasKnownExtension(path: string, extensions: ReadonlySet<string>): boolean {
  const extension = fileExtension(path)
  return extension !== null && extensions.has(toNfc(extension))
}
