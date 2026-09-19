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
 * Everything else is a workspace that exists and could not be read, and is raised. The walk
 * opens a `package.json` / `Cargo.toml` / `pyproject.toml` to ask whether it declares
 * workspaces, so one that will not parse — or that the filesystem refuses — leaves the
 * question unanswered in a directory that may be the root. Under a bare catch that became
 * `cwd`: every Symbol id is then rooted at the package the command was run from rather than at
 * the repository, and the next `aburi diff` reads the rest of the monorepo as removed.
 *
 * Which is not the whole of "this workspace is malformed", and the difference is worth knowing
 * before reading an exit code. A directory carrying one of the unconditional markers (`.git`,
 * `pnpm-workspace.yaml`, and the rest) is a root on that evidence alone, so an ordinary
 * repository's own `package.json` is never opened here — a trailing comma in it surfaces one
 * step later, out of `detectManagers`, which raises for itself. Nor does every unreadable
 * manifest on the way up reach this function: `detectWorkspaceRoot` ignores one it met in a
 * directory *above* the root it settled on, since a file outside the workspace says nothing
 * about the workspace.
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
