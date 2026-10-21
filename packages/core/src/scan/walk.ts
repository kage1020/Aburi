import { type Dirent, readdir, realpath, type Stats, stat } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { type FileSystemAdapter, type GlobOptions, glob } from "tinyglobby"
import { CoreError } from "../errors"
import { compareBy } from "../order"
import { describeThrown, isVanishedFile } from "./faults"
import type { GitignoreTree } from "./gitignore"

export interface WalkOptions
  extends Pick<
    GlobOptions,
    | "absolute"
    | "deep"
    | "dot"
    | "expandDirectories"
    | "followSymbolicLinks"
    | "ignore"
    | "onlyFiles"
  > {
  cwd: string
  /**
   * The rules under which a directory they exclude may go unlisted, `null` when none apply. They
   * excuse a failed listing only: a match under a directory they exclude is still returned.
   */
  gitignore: GitignoreTree | null
}

interface UnreadPath {
  path: string
  step: "listed" | "followed"
  error: NodeJS.ErrnoException
}

type Callback<T> = (error: NodeJS.ErrnoException | null, value: T) => void

export async function walk(patterns: readonly string[], options: WalkOptions): Promise<string[]> {
  const { gitignore, ...globOptions } = options
  const unread: UnreadPath[] = []
  const matches = await glob(patterns, { ...globOptions, fs: recordingFailures(unread) })
  await refuseUnread(resolve(options.cwd), unread, gitignore)
  return matches
}

function recordingFailures(unread: UnreadPath[]): FileSystemAdapter {
  const listing = (path: string, options: { withFileTypes: true }, done: Callback<Dirent[]>) => {
    readdir(path, options, (error, entries) => {
      if (error !== null && !vanishedDirectory(error, path)) {
        unread.push({ path, step: "listed", error })
      }
      done(error, entries)
    })
  }
  // The crawler stats what a link resolves to, and a failure there is named after the link.
  const linkTo = new Map<string, string>()
  const resolving = (path: string, done: Callback<string>) => {
    realpath(path, (error, resolved) => {
      if (error === null) linkTo.set(resolved, path)
      else if (!brokenLink(error)) unread.push({ path, step: "followed", error })
      done(error, resolved)
    })
  }
  const statting = (path: string, done: Callback<Stats>) => {
    stat(path, (error, stats) => {
      if (error !== null && !brokenLink(error)) {
        unread.push({ path: linkTo.get(path) ?? path, step: "followed", error })
      }
      done(error, stats)
    })
  }
  // The crawler calls each through this one overload, and passes its errors over.
  return {
    readdir: listing as typeof readdir,
    realpath: resolving as typeof realpath,
    stat: statting as typeof stat,
  }
}

// A listing also fails when the lookup of an entry whose type the filesystem leaves unreported
// does, and the crawler then drops every entry beside it.
function vanishedDirectory(error: NodeJS.ErrnoException, path: string): boolean {
  if (!isVanishedFile(error)) return false
  return error.path === undefined || resolve(error.path) === resolve(path)
}

// A link that dangles or loops is what the commit holds, so every checkout passes it over alike.
function brokenLink(error: NodeJS.ErrnoException): boolean {
  return isVanishedFile(error) || error.code === "ELOOP"
}

async function refuseUnread(
  root: string,
  unread: readonly UnreadPath[],
  gitignore: GitignoreTree | null,
): Promise<void> {
  const paths = unread
    .map((entry) => ({ ...entry, directory: relative(root, entry.path).split(sep).join("/") }))
    .sort(compareBy((entry) => entry.directory))
  for (const { directory, step, error } of paths) {
    if (await ignoredDirectory(directory, gitignore)) continue
    const absolute = resolve(root, directory)
    const subject = step === "listed" ? "Directory" : "Link"
    const remedy =
      gitignore === null ? "" : ". Exclude it in .gitignore, or let this process read it"
    throw new CoreError(
      `${subject} "${absolute}" could not be ${step}: ${describeThrown(error)}${remedy}`,
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
