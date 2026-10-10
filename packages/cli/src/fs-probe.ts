import { access, stat } from "node:fs/promises"
import { CliError, errorCode, errorMessage } from "./errors"

export const ABSENT_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

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

export async function pathKind(path: string): Promise<"nothing" | "file" | "directory"> {
  return probe(
    path,
    async () => ((await stat(path)).isDirectory() ? "directory" : "file"),
    "nothing",
  )
}
