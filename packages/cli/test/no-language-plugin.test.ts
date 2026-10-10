import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("no-language-plugin")

beforeEach(async () => {
  await writePackageJson(workspace.root)
  await workspace.writeSource("src/m.py", "def f():\n    return 1\n")
})

function scan() {
  return runScan({
    cwd: workspace.root,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
  })
}

describe("aburi scan with no language plugin", () => {
  it.each([
    ["an empty languages list", { languages: [] }],
    ["a config that omits languages", {}],
  ])("refuses %s, naming the config to edit", async (_, config) => {
    await writeConfig(workspace.root, config)

    const error = await errorFrom(CliError, scan)

    expect(error.code).toBe("config-error")
    expect(error.message).toContain(
      `No language plugin is configured (config: ${resolve(workspace.root, "aburi.json")})`,
    )
  })

  it("says no config was found when discovery came up empty", async () => {
    const error = await errorFrom(CliError, scan)

    expect(error.message).toContain("No language plugin is configured (no aburi.json was found)")
  })

  it("proceeds once a language plugin is configured", async () => {
    await workspace.writeSource("src/m.ts", "export const m = 1\n")
    await writeConfig(workspace.root, TYPESCRIPT)

    const report = await scan()

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.irPath).not.toBeNull()
  })
})
