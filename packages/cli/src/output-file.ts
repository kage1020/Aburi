import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { OUTPUT_DIR_SOURCES } from "./artifact-paths"
import { CliError, errorCode, errorMessage } from "./errors"
import { ABSENT_ERRNOS } from "./fs-probe"

export type OutputCommand = "init" | "scan" | "diff" | "explain"

export interface OutputArtefact {
  command: OutputCommand
  artefact: string
  path: string
}

const OUTPUT_FLAG: Record<OutputCommand, "--output" | "--output-dir"> = {
  init: "--output",
  explain: "--output",
  scan: "--output-dir",
  diff: "--output-dir",
}

export async function writeOutputFile(output: OutputArtefact, contents: string): Promise<void> {
  try {
    await mkdir(dirname(output.path), { recursive: true })
    await writeFile(output.path, contents, "utf8")
  } catch (error) {
    throw cannotWrite(output, error)
  }
}

export async function removeOutputFile(output: OutputArtefact): Promise<void> {
  await unlessAbsent(output, undefined, () => rm(output.path))
}

export async function removeOutputFileOpeningWith(
  output: OutputArtefact,
  firstLine: string,
): Promise<void> {
  if (await opensWith(output, firstLine)) await removeOutputFile(output)
}

export async function listOutputFiles(directory: OutputArtefact): Promise<string[]> {
  return unlessAbsent(directory, [], async () =>
    (await readdir(directory.path, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  )
}

async function opensWith(output: OutputArtefact, firstLine: string): Promise<boolean> {
  const opening = Buffer.alloc(Buffer.byteLength(firstLine) + "\r\n".length)
  const length = await unlessAbsent(output, null, async () => {
    const handle = await open(output.path)
    try {
      return (await handle.read(opening, 0, opening.length, 0)).bytesRead
    } finally {
      await handle.close()
    }
  })
  if (length === null) return false
  return opening.toString("utf8", 0, length).split(/\r?\n/, 1)[0] === firstLine
}

async function unlessAbsent<T>(
  output: OutputArtefact,
  absent: T,
  act: () => Promise<T>,
): Promise<T> {
  try {
    return await act()
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && ABSENT_ERRNOS.has(code)) return absent
    throw cannotWrite(output, error, "remove")
  }
}

export async function createOutputDir(command: OutputCommand, path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw cannotWrite({ command, artefact: "the output directory", path }, error)
  }
}

export function outputIsADirectory(output: OutputArtefact): CliError {
  return new CliError(
    `${describeWrite(output)}: ${isADirectory(OUTPUT_FLAG[output.command])}`,
    "input-error",
  )
}

function cannotWrite(
  output: OutputArtefact,
  error: unknown,
  verb: "write" | "remove" = "write",
): CliError {
  const prefix = describeWrite(output, verb)
  const detail = errorMessage(error)
  const remedy = unusablePath(error, OUTPUT_FLAG[output.command])
  if (remedy === null) {
    return new CliError(`${prefix}: ${detail}`, "runtime-error", { cause: error })
  }
  return new CliError(`${prefix}: ${remedy} (${detail})`, "input-error", { cause: error })
}

function describeWrite(output: OutputArtefact, verb: "write" | "remove" = "write"): string {
  return verb === "write"
    ? `aburi ${output.command} could not write ${output.artefact} to ${output.path}`
    : `aburi ${output.command} could not remove ${output.artefact} at ${output.path}`
}

function unusablePath(error: unknown, flag: "--output" | "--output-dir"): string | null {
  switch (errorCode(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return flag === "--output"
        ? "a file stands where one of its parent directories would go. Remove that file, or pass --output <path> elsewhere."
        : `a file stands where the directory would go. Remove that file, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
    case "EISDIR":
    case "ERR_FS_EISDIR":
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
