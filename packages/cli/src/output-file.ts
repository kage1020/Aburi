import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { CliError, errorCode, errorMessage } from "./errors"

/**
 * Where an artefact was told to go: the command writing it, and the flag that chose the
 * destination. Both are in every write failure's message, because a bare errno names a path
 * and nothing else — `EPERM: operation not permitted, open '…/workspace.md'` says neither
 * which command was running nor which of its outputs did not land, and the remedy (which flag
 * to point elsewhere) differs between a flag naming a file and one naming a directory.
 */
export interface OutputTarget {
  command: "init" | "scan" | "diff" | "explain"
  flag: "--output" | "--output-dir"
}

/**
 * Write one artefact, creating the directories its path names.
 *
 * `aburi scan` and `aburi diff` have always created their `--output-dir` recursively. The two
 * commands whose output flag names a *file* did not, so a path the CLI reference itself hands
 * the reader (`--output config/aburi.jsonc`, `--output docs/alpha.md`) answered with a raw
 * `ENOENT` from `writeFile` in any tree that did not already hold the directory.
 *
 * Every failure is reported as the command's, naming `artefact` and the path. The exit code
 * is decided by what failed (`cli-spec.md`, the line being who has to act): a path that
 * cannot hold a file at all is a statement about what the caller typed, so it is exit 2 with
 * the remedy spelled out; a permission, a read-only mount or a full disk is not the reader's
 * to fix, so it is exit 1 with Node's own message, which names the errno and the path.
 */
export async function writeOutputFile(
  target: OutputTarget,
  artefact: string,
  path: string,
  contents: string,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, "utf8")
  } catch (error) {
    throw cannotWrite(target, artefact, path, error)
  }
}

/**
 * Create the directory `aburi scan` and `aburi diff` write into, reported like a write of
 * anything else in it: the run is refused before it computes anything, and the message says
 * what stood in the way.
 */
export async function createOutputDir(target: OutputTarget, path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw cannotWrite(target, "the output directory", path, error)
  }
}

/**
 * The refusal for a destination that is a directory already on disk.
 *
 * Exported because `aburi init` reaches that path before the write does — its overwrite guard
 * probes for an existing file — and answering `--force` there would send the caller down a
 * road whose end is this same sentence.
 */
export function outputIsADirectory(target: OutputTarget, artefact: string, path: string): CliError {
  return new CliError(
    `${describeWrite(target, artefact, path)}: ${isADirectory(target.flag)}`,
    "input-error",
  )
}

function cannotWrite(
  target: OutputTarget,
  artefact: string,
  path: string,
  error: unknown,
): CliError {
  const remedy = unusablePath(error, target.flag)
  const detail = errorMessage(error)
  return remedy === null
    ? new CliError(`${describeWrite(target, artefact, path)}: ${detail}`, "runtime-error", {
        cause: error,
      })
    : new CliError(
        `${describeWrite(target, artefact, path)}: ${remedy} (${detail})`,
        "input-error",
        {
          cause: error,
        },
      )
}

function describeWrite(target: OutputTarget, artefact: string, path: string): string {
  return `aburi ${target.command} could not write ${artefact} to ${path}`
}

/**
 * What to tell the caller about a path that cannot hold their output, or `null` when the
 * failure was not the path's shape.
 *
 * Each errno means one thing here and nothing else. A recursive `mkdir` is silent on a
 * directory that already exists, so `EEXIST` from it is a non-directory standing exactly where
 * a directory has to go — the output directory itself, or a parent of the file — and `ENOTDIR`
 * is that same file further up the path; which of the two Node reports is only how far the
 * walk got before it hit the file. `EISDIR` can only come from the write, which truncates
 * rather than refusing an existing file, so it is the output path itself naming a directory
 * that is already there.
 */
function unusablePath(error: unknown, flag: OutputTarget["flag"]): string | null {
  switch (errorCode(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return flag === "--output"
        ? "a file stands where one of its parent directories would go. Remove that file, or pass --output <path> elsewhere."
        : "a file stands where the directory would go. Remove that file, or point --output-dir (or output.dir in aburi.json) elsewhere."
    case "EISDIR":
      return isADirectory(flag)
    default:
      return null
  }
}

function isADirectory(flag: OutputTarget["flag"]): string {
  return flag === "--output"
    ? "that path is a directory. Pass --output <path> naming the file to write."
    : "a directory stands where the file would go. Remove it, or point --output-dir (or output.dir in aburi.json) elsewhere."
}
