import { access, stat } from "node:fs/promises"
import { CliError, errorCode, errorMessage } from "./errors"

/**
 * Filesystem probes that answer "absent" only for the errnos that mean it.
 *
 * `access` and `stat` treat every errno as "not usable", but "does not exist" and "permission
 * denied" mean very different things to a caller: the first is a fall-through, the second is
 * a mistake that must surface. EACCES / EIO / ELOOP are re-thrown as `CliError` so that, for
 * example, a permission-denied on `aburi.json` cannot slip past `aburi init`'s overwrite guard
 * and let the write clobber a file the user cannot read.
 */
const ABSENT_ERRNOS = new Set(["ENOENT", "ENOTDIR"])

async function probe<T>(path: string, read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && ABSENT_ERRNOS.has(code)) return absent
    throw new CliError(`Failed to probe ${path}: ${errorMessage(error)}`, "runtime-error", {
      cause: error,
    })
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return probe(
    path,
    async () => {
      await access(path)
      return true
    },
    false,
  )
}

/**
 * What a path holds. A directory is answered apart from a file because, for an output path,
 * `--force` is no remedy for one.
 */
export async function pathKind(path: string): Promise<"nothing" | "file" | "directory"> {
  return probe(
    path,
    async () => ((await stat(path)).isDirectory() ? "directory" : "file"),
    "nothing",
  )
}
