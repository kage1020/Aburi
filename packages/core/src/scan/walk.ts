import { type Dirent, readdir } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { type GlobOptions, glob } from "tinyglobby"
import { CoreError } from "../errors"
import { compareBy } from "../order"
import { describeThrown, isVanishedFile } from "./faults"
import type { GitignoreTree } from "./gitignore"

export interface WalkOptions extends Omit<GlobOptions, "cwd" | "fs" | "patterns"> {
  cwd: string
  /** The rules under which a directory they exclude may go unlisted, `null` when none apply. */
  gitignore: GitignoreTree | null
}

interface UnlistedDirectory {
  path: string
  error: NodeJS.ErrnoException
}

export async function walk(patterns: readonly string[], options: WalkOptions): Promise<string[]> {
  const { gitignore, ...globOptions } = options
  const unlisted: UnlistedDirectory[] = []
  const matches = await glob(patterns, {
    ...globOptions,
    fs: { readdir: recordingFailures(unlisted) },
  })
  await refuseUnlisted(resolve(options.cwd), unlisted, gitignore)
  return matches
}

function recordingFailures(unlisted: UnlistedDirectory[]): typeof readdir {
  const listing = (
    path: string,
    options: { withFileTypes: true },
    callback: (error: NodeJS.ErrnoException | null, entries: Dirent[]) => void,
  ): void => {
    readdir(path, options, (error, entries) => {
      if (error !== null && !isVanishedFile(error)) unlisted.push({ path, error })
      callback(error, entries)
    })
  }
  // The crawler lists every directory through this one overload, and passes its errors over.
  return listing as typeof readdir
}

async function refuseUnlisted(
  root: string,
  unlisted: readonly UnlistedDirectory[],
  gitignore: GitignoreTree | null,
): Promise<void> {
  const directories = unlisted
    .map(({ path, error }) => ({ directory: relative(root, path).split(sep).join("/"), error }))
    .sort(compareBy((entry) => entry.directory))
  for (const { directory, error } of directories) {
    if (await ignoredDirectory(directory, gitignore)) continue
    const absolute = resolve(root, directory)
    throw new CoreError(
      `Directory "${absolute}" could not be listed: ${describeThrown(error)}`,
      { code: "scan-directory-unreadable", value: absolute },
      { cause: error },
    )
  }
}

async function ignoredDirectory(
  directory: string,
  gitignore: GitignoreTree | null,
): Promise<boolean> {
  // No rule excludes the root, and the workspace's rules say nothing about what lies outside it.
  if (gitignore === null || directory === "" || isAbsolute(directory)) return false
  if (directory === ".." || directory.startsWith("../")) return false
  return gitignore.ignoresDirectory(directory)
}
