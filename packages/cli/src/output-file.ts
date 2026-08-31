import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { CliError, errorMessage } from "./errors"

/**
 * Write one of the single-file outputs — `aburi init --output`, `aburi explain --output` —
 * creating the directories its path names.
 *
 * `aburi scan` and `aburi diff` have always created their `--output-dir` recursively. The two
 * commands whose output flag names a *file* did not, so a path the CLI reference itself hands
 * the reader (`--output config/aburi.jsonc`, `--output docs/alpha.md`) answered with a raw
 * `ENOENT` from `writeFile` in any tree that did not already hold the directory.
 *
 * What creation cannot get past is a path that cannot hold a file at all, and that is a
 * statement about what the caller typed rather than about the machine — which `cli-spec.md` §9
 * puts at exit 2, the line there being who has to act. Every other failure is rethrown
 * untouched: a permission, a read-only mount or a full disk is not the reader's to fix, exit 1
 * already says so, and Node's own message names the path.
 */
export async function writeOutputFile(path: string, contents: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, "utf8")
  } catch (error) {
    const remedy = unusablePath(error)
    if (remedy === null) throw error
    throw new CliError(`Cannot write ${path}: ${remedy} (${errorMessage(error)})`, "input-error", {
      cause: error,
    })
  }
}

/**
 * What to tell the caller about an `--output` path that cannot hold their file, or `null` when
 * the failure was not the path's shape.
 *
 * Each errno means one thing here and nothing else. A recursive `mkdir` is silent on a
 * directory that already exists, so `EEXIST` from it is a non-directory standing exactly where
 * the parent has to go, and `ENOTDIR` is that same file further up the path — which of the two
 * Node reports is only how far the walk got before it hit the file. `EISDIR` can only come from
 * the write, which truncates rather than refusing an existing file, so it is the output path
 * itself naming a directory that is already there.
 */
function unusablePath(error: unknown): string | null {
  switch (errnoOf(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return "a file stands where one of its parent directories would go. Remove that file, or pass --output <path> elsewhere."
    case "EISDIR":
      return "that path is a directory. Pass --output <path> naming the file to write."
    default:
      return null
  }
}

function errnoOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}
