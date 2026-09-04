import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import type { DiffResult } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type GitRunner, runDiff } from "../src"

/**
 * A ref diff scans two checkouts of one workspace, and the temporary directory the base one
 * lives in must not change what that workspace is called. Component autodetection falls back
 * to the directory name (component-detect.md §4.1), so a worktree at a fixed path named
 * `base` gave the two sides different Component ids and every diff of a project without a
 * declared package name reported one Component added and one removed.
 */

let scratch = ""

const CONFIG_SCHEMA = "https://aburi.kage1020.com/schema/aburi.config.v1.json"

/**
 * A workspace with no `package.json`, so nothing declares a Component name and detection has
 * only the directory to go on — the case the phantom add/remove was visible in.
 */
async function writeWorkspace(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await writeFile(
    resolve(directory, "aburi.json"),
    JSON.stringify({ $schema: CONFIG_SCHEMA, languages: ["lang-typescript"] }),
    "utf8",
  )
  await writeFile(resolve(directory, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
}

/** `git` far enough to materialise the base revision: the two sides hold the same source. */
function makeGit(): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "rev-parse --verify") return { stdout: "abc\n", stderr: "" }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      if (key === "worktree add") await writeWorkspace(args[3] ?? "")
      return { stdout: "", stderr: "" }
    },
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-identity-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff refspec mode — Component identity across the two checkouts", () => {
  it("reports no component change when only the checkout directory differs", async () => {
    await writeWorkspace(scratch)

    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir: resolve(scratch, "out"),
      format: "json",
      warn: () => {},
    })

    expect(report.diffJsonPath).not.toBeNull()
    const diff = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
    expect(diff.summary.componentsAdded).toBe(0)
    expect(diff.summary.componentsRemoved).toBe(0)
    expect(diff.components.added).toEqual([])
    expect(diff.components.removed).toEqual([])
  })

  it("names the base worktree after the head workspace directory", async () => {
    // The mechanism, asserted where a reader can see it: the id both sides land on is derived
    // from this leaf, so a worktree named anything else is the defect coming back.
    await writeWorkspace(scratch)
    const worktreePaths: string[] = []
    const runner: GitRunner = {
      async run(args) {
        const key = args.slice(0, 2).join(" ")
        if (key === "rev-parse --verify") return { stdout: "abc\n", stderr: "" }
        if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
        if (key === "worktree add") {
          worktreePaths.push(args[3] ?? "")
          await writeWorkspace(args[3] ?? "")
        }
        return { stdout: "", stderr: "" }
      },
    }

    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: runner,
      outputDir: resolve(scratch, "out"),
      format: "json",
      warn: () => {},
    })

    expect(worktreePaths.map((path) => basename(path))).toEqual([basename(scratch)])
  })
})
