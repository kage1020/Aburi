import { resolve } from "node:path"
import { CoreError, detectWorkspaceRoot } from "@aburi/core"
import { CliError } from "./errors"

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
    throw new CliError(
      `Could not determine the workspace root for ${resolve(cwd)}${subject}: ${detail}`,
      error instanceof CoreError ? "config-error" : "runtime-error",
    )
  }
}
