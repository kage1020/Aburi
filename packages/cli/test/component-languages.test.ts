import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, runScan } from "../src"
import { STUB_PLUGIN } from "./stub-language"
import { TYPESCRIPT, writeConfig, writeFileAt, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("component-languages")

async function writeLanguage(directory: string, extension: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await workspace.writeSource(join(directory, `f${index}${extension}`), "export const x = 1\n")
  }
}

async function scannedLanguages(config: Record<string, unknown>): Promise<readonly string[]> {
  await writeConfig(workspace.root, { ...TYPESCRIPT, ...config })
  const report = await runScan({ cwd: workspace.root, format: "json" })
  const ir = JSON.parse(await readFile(report.irPath ?? "", "utf8")) as IR
  expect(ir.components).toHaveLength(1)
  return ir.components[0]?.languages ?? []
}

describe("aburi scan — the languages a component is labelled with", () => {
  it.each([
    ["leaves out a language only git-ignored files are written in", {}, ["ts"]],
    [
      "counts the git-ignored files when the config turns the rule off",
      { respectGitignore: false },
      ["py", "ts"],
    ],
  ])("%s", async (_, config, languages) => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await workspace.writeSource(".gitignore", "generated/\n")

    expect(await scannedLanguages(config)).toEqual(languages)
  })

  it("leaves out a language only config.ignore's files are written in", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("fixtures", ".py")

    expect(await scannedLanguages({ ignore: ["fixtures/**"] })).toEqual(["ts"])
  })

  it("leaves out a directory only a language plugin's own drop globs exclude", async () => {
    await writeFileAt(
      workspace.root,
      "lang-stub.mjs",
      STUB_PLUGIN.replace(
        '  fileExtensions: [".stub"],',
        '  fileExtensions: [".stub"],\n  fileDropPatterns: ["**/legacy/**"],',
      ),
    )
    await writePackageJson(workspace.root)
    await workspace.writeSource("src/a.stub", "x")
    await writeLanguage("src", ".py")
    await writeLanguage("legacy", ".rs")

    expect(await scannedLanguages({ languages: ["./lang-stub.mjs"] })).toEqual(["py"])
  })
})

describe("aburi scan — a component resolution that fails", () => {
  it.each([
    [
      "a rule file it cannot use, as a runtime failure",
      async () => workspace.writeSource(".gitignore", `${"a".repeat(5_000)}\n`),
      {},
      "runtime-error",
      "Failed to resolve components",
    ],
    [
      "a manifest that cannot be parsed, as an input error",
      async () => {
        await workspace.writeSource("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n')
        await workspace.writeSource("apps/billing/package.json", "{ broken")
      },
      {},
      "config-error",
      "package.json",
    ],
    [
      "a component root the Document cannot hold, as an input error",
      async () => {},
      { components: [{ id: "app", roots: ["../outside"] }] },
      "config-error",
      "components[id=app] root",
    ],
  ])("reports %s", async (_, arrange, config, code, says) => {
    await writeLanguage("src", ".ts")
    await arrange()

    const error = await errorFrom(CliError, () => scannedLanguages(config))

    expect(error.code).toBe(code)
    expect(error.message).toContain(says)
  })
})
