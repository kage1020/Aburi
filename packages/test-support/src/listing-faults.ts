import type * as fs from "node:fs"
import { constants } from "node:os"
import { join, resolve } from "node:path"

export interface ListingFaults {
  /** Absolute path of each directory whose listing fails → the errno code it fails with. */
  readonly codes: Map<string, string>
  /** Absolute path of each link whose resolution fails → the errno code it fails with. */
  readonly links: Map<string, string>
  /** Absolute path of each directory a link resolves to whose `stat` fails → the errno code. */
  readonly targets: Map<string, string>
  /**
   * Absolute path of a directory → the entry in it whose type lookup fails with `ENOENT`, as
   * one does when the entry is deleted mid-listing on a filesystem that reports no entry types.
   */
  readonly vanishedEntries: Map<string, string>
  /** The directories, links and targets a walk asked about and was refused. */
  readonly refused: Set<string>
}

export function emptyListingFaults(): ListingFaults {
  return {
    codes: new Map(),
    links: new Map(),
    targets: new Map(),
    vanishedEntries: new Map(),
    refused: new Set(),
  }
}

export function clearListingFaults(faults: ListingFaults): void {
  faults.codes.clear()
  faults.links.clear()
  faults.targets.clear()
  faults.vanishedEntries.clear()
  faults.refused.clear()
}

type Callback<T> = (error: NodeJS.ErrnoException | null, value: T) => void

/**
 * `node:fs` with `readdir`, `realpath` and `stat` failing where `faults` says, for a `vi.mock("node:fs")`
 * factory to return. A failure made with `chmod` would not reach root, which lists a directory
 * whatever its mode, and Windows has no read bit to take away.
 */
export function fsFailingOn(actual: typeof fs, faults: ListingFaults): typeof fs {
  return {
    ...actual,
    readdir: readdirFailingOn(actual, faults),
    realpath: realpathFailingOn(actual, faults),
    stat: statFailingOn(actual, faults),
  } as typeof fs
}

function readdirFailingOn(actual: typeof fs, faults: ListingFaults) {
  return (path: string, options: { withFileTypes: true }, done: Callback<fs.Dirent[]>): void => {
    const directory = resolve(path)
    const code = faults.codes.get(directory)
    const entry = faults.vanishedEntries.get(directory)
    if (code === undefined && entry === undefined) {
      actual.readdir(path, options, done)
      return
    }
    faults.refused.add(directory)
    const error =
      code === undefined
        ? errnoError("ENOENT", "lstat", join(directory, entry ?? ""))
        : errnoError(code, "scandir", path)
    process.nextTick(() => done(error, []))
  }
}

function realpathFailingOn(actual: typeof fs, faults: ListingFaults) {
  return (path: string, done: Callback<string>): void => {
    const link = resolve(path)
    const code = faults.links.get(link)
    if (code === undefined) {
      actual.realpath(path, done)
      return
    }
    faults.refused.add(link)
    const error = errnoError(code, "realpath", path)
    process.nextTick(() => done(error, ""))
  }
}

function statFailingOn(actual: typeof fs, faults: ListingFaults) {
  return (path: string, done: Callback<fs.Stats | undefined>): void => {
    const target = resolve(path)
    const code = faults.targets.get(target)
    if (code === undefined) {
      actual.stat(path, done)
      return
    }
    faults.refused.add(target)
    const error = errnoError(code, "stat", path)
    process.nextTick(() => done(error, undefined))
  }
}

function errnoError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const errno = (constants.errno as Record<string, number | undefined>)[code]
  return Object.assign(new Error(`${code}: injected, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
    ...(errno === undefined ? {} : { errno: -errno }),
  })
}
