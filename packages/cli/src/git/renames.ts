import type { GitRenameMap } from "@aburi/diff"
import { errorMessage } from "../errors"
import type { WarnFn } from "../warn"
import type { GitRunner } from "./runner"

export async function collectRenames(
  git: GitRunner,
  cwd: string,
  spec: { base: string; head: string },
  warn: WarnFn,
): Promise<GitRenameMap | null> {
  const range = `${spec.base}..${spec.head}`
  let stdout: string
  try {
    const result = await git.run(["diff", "--find-renames", "--name-status", "-z", range], {
      cwd,
    })
    stdout = result.stdout
    if (result.stderr.trim().length > 0) {
      warn(
        `⚠ git reported while collecting renames for ${range}: ${result.stderr.trim()}. ` +
          `Rename hints may be missing (raise diff.renameLimit if it says so); moves without one are reported as removed + added, ${RENAMED_AND_SKIPPED}.`,
      )
    }
  } catch (error) {
    warn(
      `⚠ Failed to collect git renames (${errorMessage(error)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  // Outside the `try`, so a defect in the parser is never reported as git having failed.
  const parsed = parseRenameRecords(stdout)
  if (!parsed.ok) {
    warn(
      `⚠ git diff --name-status -z for ${range} produced a record this parser could not read ` +
        `(field ${parsed.index}: ${describeBadField(parsed.field)}); the diff will treat renamed files as removed + added, ${RENAMED_AND_SKIPPED}.`,
    )
    return null
  }
  return parsed.renames
}

const RENAMED_AND_SKIPPED =
  "and the Symbols of a renamed file one scan skipped as removed or added rather than unknown"

/** A field goes into a warning quoted and capped: it is a path, so it can carry control bytes. */
function describeBadField(field: string): string {
  const quoted = JSON.stringify(field)
  return quoted.length <= MAX_REPORTED_FIELD_LENGTH
    ? quoted
    : `${quoted.slice(0, MAX_REPORTED_FIELD_LENGTH)}…`
}

const MAX_REPORTED_FIELD_LENGTH = 120

const NAME_STATUS_FIELD = /^[A-Z]\d*$/

export type RenameRecords =
  | { ok: true; renames: GitRenameMap }
  | { ok: false; index: number; field: string }

export function parseRenameRecords(stdout: string): RenameRecords {
  const fields = stdout.split("\0")
  const tail = fields.pop()
  if (tail !== "") return { ok: false, index: fields.length, field: tail ?? "" }
  const renames = new Map<string, string>()
  let index = 0
  while (index < fields.length) {
    const status = fields[index]
    if (status === undefined || !NAME_STATUS_FIELD.test(status)) {
      return { ok: false, index, field: status ?? "" }
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    const recordIsTruncated = index + pathCount > fields.length - 1
    if (recordIsTruncated) return { ok: false, index, field: status }
    index += 1 + pathCount
    if (!status.startsWith("R")) continue
    const oldPath = fields[index - 2]
    const newPath = fields[index - 1]
    if (oldPath === undefined || newPath === undefined) return { ok: false, index, field: status }
    renames.set(oldPath.normalize("NFC"), newPath.normalize("NFC"))
  }
  return { ok: true, renames }
}
