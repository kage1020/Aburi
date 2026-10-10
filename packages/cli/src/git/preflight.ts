import { dirname, join, resolve } from "node:path"
import { CliError, errorCode, errorMessage } from "../errors"
import { pathExists } from "../fs-probe"
import type { GitRunner } from "./runner"

export async function assertRefResolvable(
  git: GitRunner,
  cwd: string,
  ref: string,
  role: "base" | "head",
): Promise<void> {
  try {
    await git.run(["rev-parse", "--verify", ref], { cwd })
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new CliError(
        "git executable not found in PATH. aburi diff <base>..<head> requires a working git installation. Install git or use --base/--head with pre-generated IR files.",
        "runtime-error",
        { cause: error },
      )
    }
    throw await diagnoseUnresolvedRef(git, cwd, ref, role, error)
  }
}

async function diagnoseUnresolvedRef(
  git: GitRunner,
  cwd: string,
  ref: string,
  role: "base" | "head",
  cause: unknown,
): Promise<CliError> {
  const prefix = `${role === "base" ? "Base" : "Head"} ref '${ref}' could not be resolved`
  const said = errorMessage(cause).trim()
  const outside = "Run aburi diff from inside one, or compare IR files with --base/--head."
  const unanswered = (): CliError =>
    new CliError(
      `${prefix}, and git would not say why. What it reported: ${said}`,
      "runtime-error",
      { cause },
    )

  const inside = await isInsideWorkTree(git, cwd)
  if (inside === null) {
    if (await gitRepositoryAbove(cwd)) return unanswered()
    return new CliError(
      `${prefix}: ${cwd} is not inside a git repository. ${outside} (${said})`,
      "input-error",
      { cause },
    )
  }
  if (!inside) {
    return new CliError(
      `${prefix}: ${cwd} is inside a git directory, not a working tree. ${outside} (${said})`,
      "input-error",
      { cause },
    )
  }
  const commits = await hasCommits(git, cwd)
  if (commits === null) return unanswered()
  if (!commits) {
    return new CliError(
      `${prefix}: the repository at ${cwd} has no commits yet, so there is no revision to compare. (${said})`,
      "input-error",
      { cause },
    )
  }
  return new CliError(
    `${prefix}: no such revision in this repository. Check the spelling, or fetch the branch first. (${said})`,
    "input-error",
    { cause },
  )
}

async function isInsideWorkTree(git: GitRunner, cwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await git.run(["rev-parse", "--is-inside-work-tree"], { cwd })
    return stdout.trim() === "true"
  } catch {
    return null
  }
}

async function hasCommits(git: GitRunner, cwd: string): Promise<boolean | null> {
  try {
    const { stdout } = await git.run(["rev-list", "--all", "--max-count=1"], { cwd })
    return stdout.trim().length > 0
  } catch {
    return null
  }
}

async function gitRepositoryAbove(cwd: string): Promise<boolean> {
  if (process.env.GIT_DIR !== undefined) return true
  let directory = resolve(cwd)
  for (;;) {
    if (await pathExists(join(directory, ".git"))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

export async function assertNotShallow(git: GitRunner, cwd: string): Promise<void> {
  const { stdout } = await git.run(["rev-parse", "--is-shallow-repository"], { cwd })
  if (stdout.trim() === "true") {
    throw new CliError(
      "Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow",
      "runtime-error",
    )
  }
}

export async function assertNotSparse(git: GitRunner, cwd: string): Promise<void> {
  const { stdout } = await git.run(
    ["config", "--bool", "--default", "false", "core.sparseCheckout"],
    { cwd },
  )
  if (stdout.trim() === "true") {
    throw new CliError(
      "Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable",
      "runtime-error",
    )
  }
}
