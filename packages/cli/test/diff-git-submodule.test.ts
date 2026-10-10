import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { DiffResult } from "@aburi/types"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { parseSubmodulePaths } from "../src/commands/diff"
import { CliError } from "../src/errors"
import { realGit as git, probeRealGit } from "./fixtures"

let scratch = ""
let gitProbeError: unknown = null

const LIB_SOURCE =
  "export function libFn(): number { return 1 }\nexport function libHelper(): number { return 2 }\n"

const SUBMODULE_WARNING =
  "Submodule-aware diff is not yet supported, so their files are left out of both file scans. Component detection still walks them, so a workspace package inside one can still be reported as a Component added or removed."

/** A one-commit repository holding the library, to be added as a submodule. */
async function library(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
  await writeFile(resolve(directory, "src/lib.ts"), LIB_SOURCE)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "lib"], directory)
}

/** The files every superproject here starts with, uncommitted. */
async function workspace(directory: string): Promise<void> {
  await mkdir(resolve(directory, "src"), { recursive: true })
  await git(["init", "-q", "-b", "main"], directory)
  await writeFile(resolve(directory, "package.json"), '{"name":"demo","private":true}\n')
  await writeFile(resolve(directory, "aburi.json"), '{"languages":["lang-typescript"]}\n')
  await writeFile(resolve(directory, ".gitignore"), "out/\n")
  await writeFile(
    resolve(directory, "src/main.ts"),
    "export function main(): number { return 1 }\n",
  )
}

async function addSubmodule(directory: string, lib: string, at: string): Promise<void> {
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, at], directory)
}

async function superproject(directory: string, lib: string, at: string): Promise<void> {
  await workspace(directory)
  await addSubmodule(directory, lib, at)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", "c1"], directory)
}

async function commitFunction(directory: string, file: string, name: string): Promise<void> {
  await mkdir(resolve(directory, file, ".."), { recursive: true })
  await appendFile(resolve(directory, file), `export function ${name}(): number { return 2 }\n`)
  await git(["add", "-A"], directory)
  await git(["commit", "-q", "-m", `add ${name}`], directory)
}

async function diffIn(cwd: string) {
  const warnings: string[] = []
  const result = await runDiff({
    cwd,
    refSpec: "HEAD~1..HEAD",
    outputDir: resolve(cwd, "out"),
    failOn: "added",
    warn: (message) => warnings.push(message),
  })
  return { ...result, warnings }
}

/** The names of the Symbols `diff.json` reports added, so a count cannot hide which ones. */
async function addedNames(diffJsonPath: string | null): Promise<string[]> {
  if (diffJsonPath === null) throw new Error("expected a diff.json")
  const diff = JSON.parse(await readFile(diffJsonPath, "utf8")) as DiffResult
  return diff.symbols
    .flatMap((change) => (change.status === "added" ? [change.symbol.name] : []))
    .sort()
}

beforeAll(async () => {
  gitProbeError = await probeRealGit()
})

beforeEach(async () => {
  expect(gitProbeError, `git probe failed: ${String(gitProbeError)}`).toBeNull()
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-submodule-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff in a repository with a submodule", () => {
  /** `demo` with the library at `libs/sub`, and a head commit adding `main2` to `src/main.ts`. */
  async function demoAddingMain2(): Promise<string> {
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await superproject(demo, lib, "libs/sub")
    await commitFunction(demo, "src/main.ts", "main2")
    return demo
  }

  it("leaves an unchanged submodule out of both sides, and says so", async () => {
    const demo = await demoAddingMain2()

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(await addedNames(result.diffJsonPath)).toEqual(["main2"])
    expect(result.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
    expect(result.exitCode).toBe(EXIT.GATE)
    expect(result.warnings).toEqual([`⚠ Submodules detected: libs/sub. ${SUBMODULE_WARNING}`])
  })

  it("finds the submodule from a subdirectory too", async () => {
    const demo = await demoAddingMain2()

    const result = await diffIn(resolve(demo, "src"))

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(await addedNames(result.diffJsonPath)).toEqual(["main2"])
    expect(result.warnings).toEqual([`⚠ Submodules detected: libs/sub. ${SUBMODULE_WARNING}`])
  })

  it("leaves out only the submodule when its path holds glob characters", async () => {
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await superproject(demo, lib, "libs/[x]")
    await commitFunction(demo, "libs/x/keep.ts", "keep")

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(await addedNames(result.diffJsonPath)).toEqual(["keep"])
    expect(result.warnings).toEqual([`⚠ Submodules detected: libs/[x]. ${SUBMODULE_WARNING}`])
  })

  it("reports nothing for a commit that only moves the submodule pointer", async () => {
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await superproject(demo, lib, "libs/sub")
    await commitFunction(resolve(demo, "libs/sub"), "src/lib.ts", "libExtra")
    await git(["add", "libs/sub"], demo)
    await git(["commit", "-q", "-m", "bump libs/sub"], demo)

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    expect(result.triggered).toBeNull()
    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.warnings).toEqual([`⚠ Submodules detected: libs/sub. ${SUBMODULE_WARNING}`])
  })

  it("leaves the path out of the base too, where it was a plain directory", async () => {
    const lib = resolve(scratch, "lib")
    await library(lib)
    const demo = resolve(scratch, "demo")
    await workspace(demo)
    await mkdir(resolve(demo, "libs/sub/src"), { recursive: true })
    await writeFile(resolve(demo, "libs/sub/src/lib.ts"), LIB_SOURCE)
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "c1"], demo)
    await git(["rm", "-r", "-q", "libs/sub"], demo)
    await addSubmodule(demo, lib, "libs/sub")
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "libs/sub becomes a submodule"], demo)

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    expect(result.exitCode).toBe(EXIT.SUCCESS)
    expect(result.warnings).toEqual([`⚠ Submodules detected: libs/sub. ${SUBMODULE_WARNING}`])
  })

  it("warns about nothing in a repository without submodules", async () => {
    const demo = resolve(scratch, "demo")
    await workspace(demo)
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "c1"], demo)
    await commitFunction(demo, "src/main.ts", "main2")

    const result = await diffIn(demo)

    expect(result.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(result.warnings).toEqual([])
  })
})

describe("aburi diff in a sparse checkout", () => {
  /** A two-commit repository, so `HEAD~1..HEAD` resolves. */
  async function twoCommits(): Promise<string> {
    const demo = resolve(scratch, "demo")
    await mkdir(resolve(demo, "src"), { recursive: true })
    await git(["init", "-q", "-b", "main"], demo)
    await writeFile(resolve(demo, "aburi.json"), '{"languages":["lang-typescript"]}\n')
    await writeFile(resolve(demo, "src/main.ts"), "export function main(): number { return 1 }\n")
    await git(["add", "-A"], demo)
    await git(["commit", "-q", "-m", "c1"], demo)
    await commitFunction(demo, "src/main.ts", "main2")
    return demo
  }

  const REFUSAL = {
    message:
      "Sparse-checkout detected. aburi diff requires full file tree. Disable with: git sparse-checkout disable",
    code: "runtime-error",
  }

  it("refuses to run, with the way out", async () => {
    const demo = await twoCommits()
    await git(["sparse-checkout", "set", "src"], demo)

    const run = diffIn(demo)

    await expect(run).rejects.toBeInstanceOf(CliError)
    await expect(run).rejects.toMatchObject(REFUSAL)
  })

  it("refuses `core.sparseCheckout=1` too, not only the `true` that `sparse-checkout` writes", async () => {
    const demo = await twoCommits()
    await git(["config", "core.sparseCheckout", "1"], demo)

    await expect(diffIn(demo)).rejects.toMatchObject(REFUSAL)
  })
})

describe("parseSubmodulePaths", () => {
  it("keeps gitlinks only, once each, whatever the path holds", () => {
    const stdout = [
      "100644 aaa 0\tsrc/main.ts",
      "160000 bbb 0\tlibs/sub",
      "160000 ccc 1\tlibs/conflicted",
      "160000 ddd 2\tlibs/conflicted",
      "160000 eee 0\tlibs/a\tb\nc",
      "",
    ].join("\0")

    expect(parseSubmodulePaths(stdout)).toEqual(["libs/a\tb\nc", "libs/conflicted", "libs/sub"])
  })
})
