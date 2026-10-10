import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, runDiff } from "../src"
import { commitAll, fakeGit, git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("diff-refspec")

/** The refusal of a spec, which must come before any git command runs. */
async function refusalOf(refSpec: string): Promise<CliError> {
  const { runner, asked } = fakeGit()
  const error = await errorFrom(CliError, () =>
    runDiff({
      cwd: workspace.root,
      refSpec,
      git: runner,
      outputDir: resolve(workspace.root, "out"),
      warn: () => {},
    }),
  )
  expect(error.code).toBe("input-error")
  expect(asked).toEqual([])
  return error
}

describe("aburi diff <base>..<head> — a spec it refuses", () => {
  it.each([
    [
      "main...HEAD",
      'uses the three-dot form. aburi diff compares the two revisions directly, so write it as "main..HEAD"',
    ],
    ["v1.2.0...v1.3.0", 'write it as "v1.2.0..v1.3.0"'],
    ["main", "is not a valid ref spec"],
    ["a..b..c", "is not a valid ref spec"],
    ["main....HEAD", "is not a valid ref spec"],
    ["main...", "must contain non-empty base and head refs"],
  ])("refuses %s at exit 2", async (refSpec, says) => {
    expect((await refusalOf(refSpec)).message).toContain(says)
  })

  it("names the merge base with placeholders rather than pasting the refs into a command", async () => {
    const { message } = await refusalOf("feature/$(id)...HEAD")
    expect(message).toContain("git merge-base <base> <head>")
    expect(message).not.toContain("$(git merge-base")
  })

  it("does not read a three-dot run followed by a second separator as the three-dot form", async () => {
    const { message } = await refusalOf("a...b..c")
    expect(message).toContain("is not a valid ref spec")
    expect(message).not.toContain("three-dot")
  })
})

describe("aburi diff <base>..<head> — a spec it accepts", () => {
  it("keeps refs that contain dots of their own whole, on both sides", async () => {
    const root = workspace.root
    await initRepository(root)
    await writeConfig(root, TYPESCRIPT)
    await writeFileAt(root, "src/a.ts", "export function one(): number { return 1 }\n")
    await commitAll(root, "v1.2.0")
    await git(["tag", "v1.2.0"], root)
    await writeFileAt(root, "src/b.ts", "export function two(): number { return 2 }\n")
    await commitAll(root, "v1.3.0")
    await git(["tag", "v1.3.0"], root)

    const report = await runDiff({
      cwd: root,
      refSpec: "v1.2.0..v1.3.0",
      outputDir: resolve(root, "out"),
      warn: () => {},
    })

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
  })
})
