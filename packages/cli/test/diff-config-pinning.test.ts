import { readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import type { Summary } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { type DiffOptions, EXIT, runDiff, runScan } from "../src"
import { commitAll, initRepository } from "./git"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("diff-config-pinning")

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

const NO_CHANGE = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 2 }

/**
 * A committed base whose config, at `baseConfig`, ignores `src/b.ts`, and a working tree whose
 * config, at `headConfig`, does not: the two revisions differ in nothing else.
 */
async function revisionsDifferingInConfig(headConfig: string, baseConfig = headConfig) {
  const root = workspace.root
  await initRepository(root)
  await writePackageJson(root, { name: "app" })
  await writeFileAt(root, "src/a.ts", "export function alpha() { return 1 }\n")
  await writeFileAt(root, "src/b.ts", "export function beta() { return 2 }\n")
  await writeConfig(root, { ...TYPESCRIPT, ignore: ["src/b.ts"] }, baseConfig)
  await commitAll(root, "base")
  await rm(resolve(root, baseConfig))
  await writeConfig(root, TYPESCRIPT, headConfig)
}

async function diffWorkingTree(options: Pick<DiffOptions, "configPath"> = {}) {
  const outputDir = resolve(workspace.root, "out")
  const log = recordingLogger()
  const report = await runDiff({
    cwd: workspace.root,
    refSpec: "main..HEAD",
    outputDir,
    failOn: "added",
    warn: log.warn,
    ...options,
  })
  const diff = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as {
    summary: Summary
  }
  return { report, summary: diff.summary, warnings: log.warnings }
}

describe("aburi diff — the base scan reads the head's config", () => {
  it("reports no change when the only difference between the revisions is `ignore`", async () => {
    await revisionsDifferingInConfig("aburi.json")

    const { report, summary, warnings } = await diffWorkingTree()

    expect(summary).toMatchObject(NO_CHANGE)
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([])
  })

  it.each([
    ["rather than the base's file at that path", "custom.json"],
    ["where the base has none", "aburi.json"],
  ])("reads the head's `--config` file, %s", async (_, baseConfig) => {
    await revisionsDifferingInConfig("custom.json", baseConfig)

    const { report, summary } = await diffWorkingTree({ configPath: "./custom.json" })

    expect(summary).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("ignores a base-revision config that discovery would have found first", async () => {
    await revisionsDifferingInConfig("aburi.jsonc", "aburi.json")

    const { report, summary } = await diffWorkingTree()

    expect(summary).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("loads a relative plugin ref from the head's tree, though the base revision lacks the file", async () => {
    await revisionsDifferingInConfig("aburi.json")
    await writeFileAt(workspace.root, "plugins/noop.mjs", NOOP_EFFECTS_PLUGIN)
    await writeConfig(workspace.root, {
      ...TYPESCRIPT,
      ignore: ["plugins/**"],
      effects: ["./plugins/noop.mjs"],
    })

    const { report, summary } = await diffWorkingTree()

    expect(summary).toMatchObject(NO_CHANGE)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})

describe("a pinned config replaces discovery rather than seeding it", () => {
  it("autodetects when told to, even standing in a directory that has a config", async () => {
    await writeConfig(workspace.root, TYPESCRIPT)

    await expect(
      runScan({
        cwd: workspace.root,
        pinnedConfig: { kind: "autodetect" },
        outputDir: resolve(workspace.root, "out"),
        format: "json",
      }),
    ).rejects.toThrow(/no aburi.json was found/)
  })
})
