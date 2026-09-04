import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff } from "../src"
import { DIFF_JSON_FILENAME } from "../src/artifact-paths"

/**
 * `cli-spec.md` §6.4 step 3: the base scan reads the **head**'s `aburi.json`.
 *
 * The base is interpreted through the head's view on purpose. Under the base's own config a
 * commit that edits nothing but `ignore` moves every Symbol the setting covers, so `aburi
 * diff HEAD~1..HEAD --fail-on added` fails a pull request that changed no source at all — and
 * the counts it reports are about the config, not about the change under review.
 *
 * Both routes to a config had to be pinned to make that true. Discovery walks up from the
 * scan's cwd, which for the base scan is the temporary worktree; a relative `--config`
 * resolves against the same directory. Each returned the base revision's copy of the file.
 */

let scratch = ""
let head = ""
let baseTree = ""

/**
 * A workspace that is one package, in two revisions that differ only in their config.
 *
 * `src/b.ts` is what the two configs disagree about, and it carries a non-empty body: an
 * empty one is dropped as boilerplate, which would make "no added Symbol" true for the wrong
 * reason.
 */
async function makeRevisions(configName: string, baseConfigName = configName): Promise<void> {
  for (const dir of [head, baseTree]) {
    await mkdir(resolve(dir, "src"), { recursive: true })
    await writeFile(resolve(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8")
    // A bare `package.json` is not a workspace marker, and the temp directory has no ancestor
    // that is one — so without this the run cannot decide what the workspace root is.
    await writeFile(resolve(dir, ".aburi-workspace"), "", "utf8")
    await writeFile(resolve(dir, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
    await writeFile(resolve(dir, "src/b.ts"), "export function beta() { return 2 }\n", "utf8")
  }
  await writeConfig(resolve(head, configName), undefined)
  // The base revision hides `src/b.ts`. Read, it removes beta from the base IR and the head's
  // beta becomes an addition somebody made.
  await writeConfig(resolve(baseTree, baseConfigName), ["src/b.ts"])
  expect(await detectWorkspaceRoot({ cwd: head })).toBe(head)
}

async function writeConfig(path: string, ignore: readonly string[] | undefined): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...(ignore === undefined ? {} : { ignore }),
    }),
    "utf8",
  )
}

/**
 * A `git` that materializes the base revision the way `worktree add` does, so the base scan
 * meets a real directory with a real config in it. Nothing here is stubbed at the config
 * layer — the defect lives in which file the scan opens, so the test has to let it open one.
 */
function makeGit(): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "rev-parse --verify") return { stdout: "abc123\n", stderr: "" }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      if (key === "worktree add") {
        const destination = args[3]
        if (destination === undefined) throw new Error("worktree add without a destination")
        await cp(baseTree, destination, { recursive: true })
      }
      return { stdout: "", stderr: "" }
    },
  }
}

interface DiffSummary {
  added: number
  removed: number
  changed: number
}

async function readSummary(outputDir: string): Promise<DiffSummary> {
  const raw = await readFile(resolve(outputDir, DIFF_JSON_FILENAME), "utf8")
  return (JSON.parse(raw) as { summary: DiffSummary }).summary
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-cfg-"))
  head = resolve(scratch, "head")
  baseTree = resolve(scratch, "base")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff — the base scan reads the head's config", () => {
  it("reports no change when the only difference between the revisions is `ignore`", async () => {
    await makeRevisions("aburi.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      failOn: "added",
      warn: () => {},
    })

    // Under the base's own config `src/b.ts` is absent from the base IR, so `beta` reads as
    // `added` and the gate trips on a commit that touched no source.
    expect(await readSummary(outputDir)).toMatchObject({ added: 0, removed: 0, changed: 0 })
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("resolves a relative `--config` against the caller's directory, not the worktree", async () => {
    await makeRevisions("custom.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      configPath: "./custom.json",
      outputDir,
      failOn: "added",
      warn: () => {},
    })

    // `resolve(worktreeDir, "./custom.json")` is the base copy of the file, and it exists —
    // so the override was read twice, once per revision, rather than pinned once.
    expect(await readSummary(outputDir)).toMatchObject({ added: 0, removed: 0, changed: 0 })
    expect(report.triggered).toBeNull()
  })

  it("ignores a base-revision config the head does not have at that path", async () => {
    // The head's config moved: `custom.json` at the head, `aburi.json` at the base. Discovery
    // from inside the worktree finds the stale `aburi.json`; the pinned path does not exist
    // there at all, which is the point — the head's file is read from the head's tree.
    await makeRevisions("custom.json", "aburi.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      configPath: "./custom.json",
      outputDir,
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject({ added: 0, removed: 0, changed: 0 })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})
