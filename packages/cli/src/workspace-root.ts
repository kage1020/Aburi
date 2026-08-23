import { resolve } from "node:path"
import { CoreError, detectWorkspaceRoot } from "@aburi/core"
import { CliError } from "./errors"

/**
 * The workspace root for a command running in `cwd`, or `cwd` itself when there is no
 * workspace around it.
 *
 * One absorbed failure, and it is the one `detectWorkspaceRoot` documents as expected:
 * `workspace-root-not-found` means no marker exists anywhere between `cwd` and the filesystem
 * root, so a single directory is the whole workspace. A scan of a bare folder is a supported
 * thing to do and must not need a `package.json` first.
 *
 * Everything else is a workspace that exists and could not be read, and absorbing it answers a
 * question nobody asked: `detectWorkspaceRoot` also raises `workspace-manifest-malformed` for a
 * root `package.json` or `pnpm-workspace.yaml` that will not parse — a leftover conflict marker
 * is enough — `workspace-root-outside` for a manifest naming a package above the root, and the
 * `EACCES` and `EIO` its own probing hits. Under a bare catch a trailing comma in the root
 * manifest silently makes `cwd` the workspace root, and every Symbol id is then rooted at the
 * package rather than the repository, so the next `aburi diff` reads the rest of the monorepo
 * as removed.
 *
 * Shared rather than written at each caller, because they had drifted into two copies of the
 * bare catch and the consequences are not the same in each: `aburi scan` mints ids from this,
 * and `aburi explain` bounds its search for a written IR by it — where a collapsed root also
 * makes the "nor in any directory up to …" line claim a search that did not happen.
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
