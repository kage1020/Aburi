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

type Step = "write" | "remove" | "list" | "read"

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
    throw cannot("write", output, error)
  }
}

export async function removeOutputFile(output: OutputArtefact): Promise<boolean> {
  return unlessAbsent("remove", output, false, async () => {
    await rm(output.path)
    return true
  })
}

export async function removeOutputFileOpeningWith(
  output: OutputArtefact,
  firstLine: string,
): Promise<boolean> {
  return (await opensWith(output, firstLine)) && (await removeOutputFile(output))
}

export async function listOutputFiles(directory: OutputArtefact): Promise<string[]> {
  return unlessAbsent("list", directory, [], async () =>
    (await readdir(directory.path, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  )
}

async function opensWith(output: OutputArtefact, firstLine: string): Promise<boolean> {
  const opening = Buffer.alloc(Buffer.byteLength(firstLine) + "\r\n".length)
  const length = await unlessAbsent("read", output, null, () => readInto(output.path, opening))
  if (length === null) return false
  const text = opening.toString("utf8", 0, length)
  return ["\n", "\r\n"].some((ending) => text.startsWith(`${firstLine}${ending}`))
}

async function readInto(path: string, buffer: Buffer): Promise<number> {
  const handle = await open(path)
  try {
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length
  } finally {
    await handle.close()
  }
}

async function unlessAbsent<T>(
  step: Step,
  output: OutputArtefact,
  absent: T,
  act: () => Promise<T>,
): Promise<T> {
  try {
    return await act()
  } catch (error) {
    const code = errorCode(error)
    if (code !== null && ABSENT_ERRNOS.has(code)) return absent
    throw cannot(step, output, error)
  }
}

export async function createOutputDir(command: OutputCommand, path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw cannot("write", { command, artefact: "the output directory", path }, error)
  }
}

export function outputIsADirectory(output: OutputArtefact): CliError {
  return new CliError(
    `${describeFailure("write", output)}: ${isADirectory(OUTPUT_FLAG[output.command])}`,
    "input-error",
  )
}

function cannot(step: Step, output: OutputArtefact, error: unknown): CliError {
  const prefix = describeFailure(step, output)
  const detail = errorMessage(error)
  const remedy = unusablePath(error, OUTPUT_FLAG[output.command], step)
  if (remedy === null) {
    return new CliError(`${prefix}: ${detail}`, "runtime-error", { cause: error })
  }
  return new CliError(`${prefix}: ${remedy} (${detail})`, "input-error", { cause: error })
}

function describeFailure(step: Step, { command, artefact, path }: OutputArtefact): string {
  return step === "write"
    ? `aburi ${command} could not write ${artefact} to ${path}`
    : `aburi ${command} could not ${step} ${artefact} at ${path}`
}

function unusablePath(
  error: unknown,
  flag: "--output" | "--output-dir",
  step: Step,
): string | null {
  switch (errorCode(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return flag === "--output"
        ? "a file stands where one of its parent directories would go. Remove that file, or pass --output <path> elsewhere."
        : `a file stands where the directory would go. Remove that file, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
    case "EISDIR":
    case "ERR_FS_EISDIR":
      return step === "write"
        ? isADirectory(flag)
        : `a directory stands where an earlier run's file would be. Remove it, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
    default:
      return null
  }
}

function isADirectory(flag: "--output" | "--output-dir"): string {
  return flag === "--output"
    ? "that path is a directory. Pass --output <path> naming the file to write."
    : `a directory stands where the file would go. Remove it, or point ${OUTPUT_DIR_SOURCES} elsewhere.`
}
