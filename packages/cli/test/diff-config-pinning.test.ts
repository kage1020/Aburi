import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { detectWorkspaceRoot } from "@aburi/core"
import type { Summary } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runDiff, runScan } from "../src"
import { DIFF_JSON_FILENAME } from "../src/artifact-paths"
import { fakeGit } from "./fixtures"

let scratch = ""
let head = ""
let baseTree = ""

async function makeRevisions(configName: string, baseConfigName = configName): Promise<void> {
  for (const dir of [head, baseTree]) {
    await mkdir(resolve(dir, "src"), { recursive: true })
    await writeFile(resolve(dir, "package.json"), JSON.stringify({ name: "app" }), "utf8")
    await writeFile(resolve(dir, ".aburi-workspace"), "", "utf8")
    await writeFile(resolve(dir, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
    await writeFile(resolve(dir, "src/b.ts"), "export function beta() { return 2 }\n", "utf8")
  }
  await writeConfig(resolve(head, configName), undefined)
  await writeConfig(resolve(baseTree, baseConfigName), ["src/b.ts"])
  expect(await detectWorkspaceRoot({ cwd: head })).toBe(head)
}

async function writeConfig(
  path: string,
  ignore: readonly string[] | undefined,
  effects: readonly string[] = [],
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...(effects.length === 0 ? {} : { effects }),
      ...(ignore === undefined ? {} : { ignore }),
    }),
    "utf8",
  )
}

/** An effects plugin that classifies nothing — enough to be loaded, and no more. */
const NOOP_EFFECTS_PLUGIN = `
export const plugin = {
  manifest: {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "effects-noop",
    version: "0.0.0",
    type: "effects",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: [],
    },
  },
  async init() {},
  classify() {
    return null
  },
}
`

function makeGit(): GitRunner {
  return fakeGit({ onWorktreeAdd: (destination) => cp(baseTree, destination, { recursive: true }) })
    .runner
}

async function readSummary(outputDir: string): Promise<Summary> {
  const raw = await readFile(resolve(outputDir, DIFF_JSON_FILENAME), "utf8")
  return (JSON.parse(raw) as { summary: Summary }).summary
}

const NO_CHANGE = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 2 }

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
    const warnings: string[] = []

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      failOn: "added",
      warn: (m) => warnings.push(m),
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([])
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

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("reads the `--config` file the head names even when the base has none at that path", async () => {
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

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("ignores a base-revision config discovery would have preferred over the head's", async () => {
    await makeRevisions("aburi.jsonc", "aburi.json")
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      failOn: "added",
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("a relative plugin ref in the head's config resolves in the head's tree", () => {
  it("loads a plugin the head added and the base revision does not have", async () => {
    await makeRevisions("aburi.json")
    await mkdir(resolve(head, "plugins"), { recursive: true })
    await writeFile(resolve(head, "plugins/noop.mjs"), NOOP_EFFECTS_PLUGIN, "utf8")
    await writeConfig(resolve(head, "aburi.json"), ["plugins/**"], ["./plugins/noop.mjs"])
    const outputDir = resolve(scratch, "out")

    const report = await runDiff({
      cwd: head,
      refSpec: "main..HEAD",
      git: makeGit(),
      outputDir,
      warn: () => {},
    })

    expect(await readSummary(outputDir)).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("a pinned config replaces discovery rather than seeding it", () => {
  it("autodetects when told to, even standing in a directory that has a config", async () => {
    await makeRevisions("aburi.json")

    await expect(
      runScan({
        cwd: head,
        pinnedConfig: { kind: "autodetect" },
        outputDir: resolve(scratch, "out"),
        format: "json",
      }),
    ).rejects.toThrow(/no aburi.json was found/)
  })
})
