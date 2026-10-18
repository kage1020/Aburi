import type * as fs from "node:fs"
import { resolve } from "node:path"

export interface ListingFaults {
  /** Absolute path of each directory whose listing fails → the errno code it fails with. */
  readonly codes: Map<string, string>
  /** The directories a walk asked to list and was refused. */
  readonly refused: Set<string>
}

/**
 * `fs.readdir` failing on the directories `faults` names, for a `vi.mock("node:fs")` factory to put
 * in place of the real one. A failure made with `chmod` would not reach root, which lists a
 * directory whatever its mode, and Windows has no read bit to take away.
 */
export function readdirFailingOn(
  actual: typeof fs,
  faults: ListingFaults,
): (...args: Parameters<typeof fs.readdir>) => void {
  return (...args) => {
    const [path, , callback] = args
    const directory = resolve(String(path))
    const code = faults.codes.get(directory)
    if (code === undefined) return actual.readdir(...args)
    faults.refused.add(directory)
    const error = Object.assign(new Error(`${code}: injected, scandir '${String(path)}'`), { code })
    process.nextTick(() => callback(error, []))
  }
}
