import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { OUTPUT_DIR_SOURCES } from "./artifact-paths"
import { CliError, errorCode, errorMessage } from "./errors"

/** The commands that write artefacts, as a failure names them: `aburi scan could not write …`. */
export type OutputCommand = "init" | "scan" | "diff" | "explain"

/**
 * One artefact and where it was told to go. Every failure message opens with the command and
 * the artefact, because a bare errno names a path and nothing else — `EPERM: operation not
 * permitted, open '…/workspace.md'` says neither which command was running nor which of its
 * outputs did not land.
 */
export interface OutputArtefact {
  command: OutputCommand
  /** What the file is, in words — `the IR`, `the config` — rather than its basename, which the path shows. */
  artefact: string
  path: string
}

/**
 * The flag that decides where a command's artefacts go, and so the one a remedy names. A
 * function of the command rather than a second field on `OutputArtefact`: the two commands
 * whose flag names a file never take the directory remedy, and the type must not be able to
 * say otherwise.
 */
const OUTPUT_FLAG: Record<OutputCommand, "--output" | "--output-dir"> = {
  init: "--output",
  explain: "--output",
  scan: "--output-dir",
  diff: "--output-dir",
}

/**
 * Write one artefact, creating the directories its path names.
 *
 * A failure is the command's, naming the artefact and the path, and its exit code follows who
 * has to act (`cli-spec.md` §9): a path that cannot hold the output is a statement about what
 * the caller typed, so it is exit 2 with the flag to point elsewhere named; a permission, a
 * read-only mount or a full disk is not the reader's to fix, so it is exit 1. Node's own
 * message, which carries the errno and the path, closes both.
 */
export async function writeOutputFile(output: OutputArtefact, contents: string): Promise<void> {
  try {
    await mkdir(dirname(output.path), { recursive: true })
    await writeFile(output.path, contents, "utf8")
  } catch (error) {
    throw cannotWrite(output, error)
  }
}

/**
 * Create the directory `aburi scan` and `aburi diff` write into. Both call it ahead of the
 * scan or the comparison, so an unusable destination is refused before anything is computed
 * for it, and the failure reads like a write of anything else in it.
 */
export async function createOutputDir(command: OutputCommand, path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw cannotWrite({ command, artefact: "the output directory", path }, error)
  }
}

/**
 * The refusal for a destination that is a directory already on disk.
 *
 * Exported because `aburi init` reaches that path before the write does — its overwrite guard
 * probes for an existing file — and answering `--force` there would send the caller down a
 * road whose end is this same sentence.
 */
export function outputIsADirectory(output: OutputArtefact): CliError {
  return new CliError(
    `${describeWrite(output)}: ${isADirectory(OUTPUT_FLAG[output.command])}`,
    "input-error",
  )
}

/**
 * The error for a write that failed, decided by whether a remedy exists: none means the
 * machine's fault, one means the caller's.
 */
function cannotWrite(output: OutputArtefact, error: unknown): CliError {
  const prefix = describeWrite(output)
  const detail = errorMessage(error)
  const remedy = unusablePath(error, OUTPUT_FLAG[output.command])
  if (remedy === null) {
    return new CliError(`${prefix}: ${detail}`, "runtime-error", { cause: error })
  }
  return new CliError(`${prefix}: ${remedy} (${detail})`, "input-error", { cause: error })
}

function describeWrite(output: OutputArtefact): string {
  return `aburi ${output.command} could not write ${output.artefact} to ${output.path}`
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
function unusablePath(error: unknown, flag: "--output" | "--output-dir"): string | null {
  switch (errorCode(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return flag === "--output"
        ? "a file stands where one of its parent directories would go. Remove that file, or pass --output <path> elsewhere."
        : `a file stands where the directory would go. Remove that file, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
    case "EISDIR":
      return isADirectory(flag)
    default:
      return null
  }
}

function isADirectory(flag: "--output" | "--output-dir"): string {
  return flag === "--output"
    ? "that path is a directory. Pass --output <path> naming the file to write."
    : `a directory stands where the file would go. Remove it, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
}
