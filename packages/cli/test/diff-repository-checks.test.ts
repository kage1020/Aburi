import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, runDiff } from "../src"
import { commitAll, git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("diff-repository-checks")

const SPARSE_REFUSAL =
  "Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable"

async function twoCommits(directory: string): Promise<void> {
  await initRepository(directory)
  await writeConfig(directory, TYPESCRIPT)
  await writeFileAt(directory, "src/main.ts", "export function main(): number { return 1 }\n")
  await commitAll(directory, "c1")
  await writeFileAt(directory, "src/main.ts", "export function main(): number { return 2 }\n")
  await commitAll(directory, "c2")
}

function diffIn(cwd: string, refSpec = "HEAD~1..HEAD"): Promise<CliError> {
  return errorFrom(CliError, () =>
    runDiff({ cwd, refSpec, outputDir: resolve(cwd, "out"), warn: () => {} }),
  )
}

async function linkedWorktrees(directory: string): Promise<string[]> {
  const listing = await git(["worktree", "list", "--porcelain"], directory)
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .slice(1)
}

describe("aburi diff in a sparse checkout", () => {
  it("refuses to run, with the way out, before it adds a worktree", async () => {
    await twoCommits(workspace.root)
    await git(["sparse-checkout", "set", "src"], workspace.root)

    const refusal = await diffIn(workspace.root)

    expect(refusal).toMatchObject({ code: "runtime-error", message: SPARSE_REFUSAL })
    expect(await linkedWorktrees(workspace.root)).toEqual([])
  })

  it("refuses `core.sparseCheckout=1` too, not only the `true` that `sparse-checkout` writes", async () => {
    await twoCommits(workspace.root)
    await git(["config", "core.sparseCheckout", "1"], workspace.root)

    expect(await diffIn(workspace.root)).toMatchObject({
      code: "runtime-error",
      message: SPARSE_REFUSAL,
    })
  })
})

describe("aburi diff in a shallow clone", () => {
  it("refuses to run, and says how to fetch the history it needs", async () => {
    const origin = resolve(workspace.root, "origin")
    const clone = resolve(workspace.root, "clone")
    await twoCommits(origin)
    await git(["clone", "-q", "--depth", "1", pathToFileURL(origin).href, clone], workspace.root)

    expect(await diffIn(clone, "HEAD..HEAD")).toMatchObject({
      code: "runtime-error",
      message:
        "Repository is shallow. aburi diff requires base ref history. Run: git fetch --unshallow",
    })
  })
})
