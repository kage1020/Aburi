import { appendFile, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { parseSubmodulePaths } from "../src/git/submodules"
import { commitAll, git, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-submodules")

const LIB_SOURCE =
  "export function libFn(): number { return 1 }\nexport function libHelper(): number { return 2 }\n"

const WARNING = (paths: string) =>
  `⚠ Submodules detected: ${paths}. Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed.`

async function library(): Promise<string> {
  const lib = resolve(workspace.root, "lib")
  await initRepository(lib)
  await writeFileAt(lib, "src/lib.ts", LIB_SOURCE)
  await commitAll(lib, "lib")
  return lib
}

/** The files every superproject here starts with, uncommitted. */
async function demoWorkspace(): Promise<string> {
  const demo = resolve(workspace.root, "demo")
  await initRepository(demo)
  await writePackageJson(demo, { name: "demo", private: true })
  await writeConfig(demo, TYPESCRIPT)
  await writeFileAt(demo, ".gitignore", "out/\n")
  await writeFileAt(demo, "src/main.ts", "export function main(): number { return 1 }\n")
  return demo
}

async function addSubmodule(demo: string, lib: string, at: string): Promise<void> {
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, at], demo)
}

async function superproject(at: string): Promise<string> {
  const lib = await library()
  const demo = await demoWorkspace()
  await addSubmodule(demo, lib, at)
  await commitAll(demo, "c1")
  return demo
}

async function commitFunction(directory: string, file: string, name: string): Promise<void> {
  await mkdir(resolve(directory, file, ".."), { recursive: true })
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await commitAll(directory, `add ${name}`)
}

async function diffIn(cwd: string) {
  const log = recordingLogger()
  const report = await runDiff({
    cwd,
    refSpec: "HEAD~1..HEAD",
    outputDir: resolve(cwd, "out"),
    failOn: "added",
    warn: log.warn,
  })
  return { report, warnings: log.warnings }
}

/** The names of the Symbols `diff.json` reports added, so a count cannot hide which ones. */
async function addedNames(diffJsonPath: string | null): Promise<string[]> {
  const diff = JSON.parse(await readFile(diffJsonPath ?? "", "utf8")) as DiffResult
  return diff.symbols
    .flatMap((change) => (change.status === "added" ? [change.symbol.name] : []))
    .sort()
}

describe("aburi diff in a repository with a submodule", () => {
  it.each([
    ["the repository root", ""],
    ["a subdirectory", "src"],
  ])("leaves an unchanged submodule out of both sides, run from %s", async (_, below) => {
    const demo = await superproject("libs/sub")
    await commitFunction(demo, "src/main.ts", "main2")

    const { report, warnings } = await diffIn(resolve(demo, below))

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(await addedNames(report.diffJsonPath)).toEqual(["main2"])
    expect(report.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings).toEqual([WARNING("libs/sub")])
  })

  it("leaves out only the submodule when its path holds glob characters", async () => {
    const demo = await superproject("libs/[x]")
    await commitFunction(demo, "libs/x/keep.ts", "keep")

    const { report, warnings } = await diffIn(demo)

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(await addedNames(report.diffJsonPath)).toEqual(["keep"])
    expect(warnings).toEqual([WARNING("libs/[x]")])
  })

  it("reports nothing for a commit that only moves the submodule pointer", async () => {
    const demo = await superproject("libs/sub")
    await commitFunction(resolve(demo, "libs/sub"), "src/lib.ts", "libExtra")
    await git(["add", "libs/sub"], demo)
    await git(["commit", "-q", "-m", "bump libs/sub"], demo)

    const { report, warnings } = await diffIn(demo)

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([WARNING("libs/sub")])
  })

  it("leaves the path out of the base too, where it was a plain directory", async () => {
    const lib = await library()
    const demo = await demoWorkspace()
    await writeFileAt(demo, "libs/sub/src/lib.ts", LIB_SOURCE)
    await commitAll(demo, "c1")
    await git(["rm", "-r", "-q", "libs/sub"], demo)
    await addSubmodule(demo, lib, "libs/sub")
    await commitAll(demo, "libs/sub becomes a submodule")

    const { report, warnings } = await diffIn(demo)

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([WARNING("libs/sub")])
  })

  it("warns about nothing in a repository without submodules", async () => {
    const demo = await demoWorkspace()
    await commitAll(demo, "c1")
    await commitFunction(demo, "src/main.ts", "main2")

    const { report, warnings } = await diffIn(demo)

    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(warnings).toEqual([])
  })
})

describe("parseSubmodulePaths", () => {
  it("keeps gitlinks only, once each, spelled as git wrote them", () => {
    const decomposed = "libs/café"
    const stdout = [
      "100644 aaa 0\tsrc/main.ts",
      "160000 bbb 0\tlibs/sub",
      "160000 ccc 1\tlibs/conflicted",
      "160000 ddd 2\tlibs/conflicted",
      "160000 eee 0\tlibs/a\tb\nc",
      `160000 fff 0\t${decomposed}`,
      "",
    ].join("\0")

    expect(parseSubmodulePaths(stdout)).toEqual([
      "libs/a\tb\nc",
      decomposed,
      "libs/conflicted",
      "libs/sub",
    ])
  })
})
