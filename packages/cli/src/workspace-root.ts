import { resolve } from "node:path"
import { CoreError, detectWorkspaceRoot } from "@aburi/core"
import { CliError } from "./errors"

/**
 * The workspace root for a command running in `cwd`, or `cwd` itself when there is no
 * workspace around it.
 *
 * One absorbed failure: `workspace-root-not-found` means no marker exists anywhere between
 * `cwd` and the filesystem root, so a single directory is the whole workspace. A scan of a
 * bare folder is supported and must not need a `package.json` first.
 *
 * Everything else is a workspace that exists and could not be read — a root `package.json`
 * that will not parse, a manifest naming a package above the root, an `EACCES` — and is
 * raised. Under a bare catch a trailing comma in the root manifest silently makes `cwd` the
 * workspace root, every Symbol id is then rooted at the package rather than the repository,
 * and the next `aburi diff` reads the rest of the monorepo as removed.
 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await detectWorkspaceRoot({ cwd })
  } catch (error) {
    if (error instanceof CoreError && error.code === "workspace-root-not-found") {
      return resolve(cwd)
    }
    const subject =
      error instanceof CoreError && error.value !== undefined ? ` (${error.value})` : ""
    const detail = error instanceof Error ? error.message : String(error)
    // A `CoreError` here is a file in the project that Aburi could not use, which is the
    // reader's to fix — exit 2. Anything else came from the machine and is exit 1.
    throw new CliError(
      `Could not determine the workspace root for ${resolve(cwd)}${subject}: ${detail}`,
      error instanceof CoreError ? "config-error" : "runtime-error",
    )
  }
}
