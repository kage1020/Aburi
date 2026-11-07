import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  commitAll,
  git,
  initRepository,
  recordingLogger,
  useScratchWorkspace,
} from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { defaultGitRunner } from "../src/git/runner"
import { warnOnPlainFileLinks } from "../src/git/symlinks"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-symlinks")

const LINKS: readonly (readonly [string, string])[] = [
  ["src/linked.ts", "main.ts"],
  ["docs/café", "../README.md"],
  ["vendor/lib", "../node_modules/lib"],
]

const warning = (ref: string, paths: readonly string[]) =>
  `⚠ The base ref "${ref}" holds ${paths.length} symbolic link(s): ${paths.join(", ")}. ` +
  "core.symlinks is false, so git checks each out in the base worktree as a plain file holding the link's target, " +
  "and the base scan reads one with a source extension as source, where it passes over a link. " +
  "A working tree checked out the same way is read the same on the head side. " +
  "Set core.symlinks to true where links can be created (on Windows, with Developer Mode) to keep them links."

/** Links are written to the index, so no fixture needs the privilege to create one. */
async function commitLinks(repo: string, links: readonly (readonly [string, string])[]) {
  for (const [path, target] of links) {
    const blob = resolve(workspace.root, "link-target")
    await writeFile(blob, target)
    const sha = (await git(["hash-object", "-w", blob], repo)).trim()
    await git(["update-index", "--add", "--cacheinfo", `120000,${sha},${path}`], repo)
  }
  await git(["commit", "-q", "-m", "links"], repo)
}

async function repository(symlinks: "true" | "false"): Promise<string> {
  const demo = resolve(workspace.root, "demo")
  await initRepository(demo)
  await git(["config", "core.symlinks", symlinks], demo)
  await writePackageJson(demo, { name: "demo", private: true })
  await writeConfig(demo, TYPESCRIPT)
  await writeFileAt(demo, ".gitignore", "out/\n")
  await writeFileAt(demo, "src/main.ts", "export function main(): number { return 1 }\n")
  await commitAll(demo, "c1")
  return demo
}

describe("aburi diff over a base ref that holds symbolic links", () => {
  it("names each link git checks out as a plain file under core.symlinks=false, and runs on", async () => {
    const demo = await repository("false")
    await commitLinks(demo, LINKS)
    await git(["checkout", "--", "."], demo)
    await writeFileAt(demo, "src/main.ts", "export function main(): number { return 2 }\n")
    await commitAll(demo, "c2")
    const log = recordingLogger()

    const report = await runDiff({
      cwd: demo,
      refSpec: "HEAD~1..HEAD",
      outputDir: resolve(demo, "out"),
      warn: log.warn,
    })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(log.warnings).toEqual([warning("HEAD~1", ["docs/café", "src/linked.ts", "vendor/lib"])])
  })
})

describe("warnOnPlainFileLinks", () => {
  it("says nothing when core.symlinks is true, or when the base ref holds no link", async () => {
    const linked = await repository("true")
    await commitLinks(linked, LINKS)
    const log = recordingLogger()

    await warnOnPlainFileLinks(defaultGitRunner, linked, "HEAD", log.warn)
    await git(["config", "core.symlinks", "false"], linked)
    await warnOnPlainFileLinks(defaultGitRunner, linked, "HEAD~1", log.warn)

    expect(log.warnings).toEqual([])
  })

  it("lists the links under the workspace root, as paths from it", async () => {
    const demo = await repository("false")
    await mkdir(resolve(demo, "apps/web"), { recursive: true })
    await commitLinks(demo, [
      ["apps/web/src/linked.ts", "main.ts"],
      ["shared/linked.ts", "../src/main.ts"],
    ])
    const log = recordingLogger()

    await warnOnPlainFileLinks(defaultGitRunner, resolve(demo, "apps/web"), "HEAD", log.warn)

    expect(log.warnings).toEqual([warning("HEAD", ["src/linked.ts"])])
  })
})
