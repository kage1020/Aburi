import { readFile } from "node:fs/promises"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runInit } from "../src"
import { writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("init-plugin-refs")

interface WrittenConfig {
  languages: string[]
  frameworks: string[]
  components: { languages: string[]; frameworks: string[] }[]
}

async function writeApp(dependencies: Record<string, string>): Promise<void> {
  await writePackageJson(workspace.root, { name: "app", private: true, dependencies })
  await workspace.writeSource("src/a.ts", "export function alpha() {}\n")
}

async function initWithDependencies(dependencies: Record<string, string>) {
  await writeApp(dependencies)
  const report = await runInit({ cwd: workspace.root })
  const config = JSON.parse(await readFile(report.outputPath, "utf8")) as WrittenConfig
  return { report, config }
}

describe("aburi init — the plugins it writes", () => {
  it.each([
    ["@nestjs/core", "nestjs", "framework-nestjs"],
    ["@trpc/server", "trpc", "framework-trpc"],
  ])("writes the plugin for %s at the top level and its detector id inside components[]", async (dependency, framework, plugin) => {
    const { report, config } = await initWithDependencies({ [dependency]: "^10.0.0" })

    expect(config.languages).toEqual(["lang-typescript"])
    expect(config.frameworks).toEqual([plugin])
    expect(config.components).toEqual([
      expect.objectContaining({ languages: ["ts"], frameworks: [framework] }),
    ])
    expect(report.detectedLanguages).toEqual(["ts"])
    expect(report.detectedFrameworks).toEqual([framework])
    expect(report.unmappedFrameworks).toEqual([])
  })

  it("suggests the language plugin ahead of the framework plugins", async () => {
    await writeApp({ "@nestjs/core": "^10.0.0" })

    const report = await runInit({ cwd: workspace.root, withSuggestions: true })

    expect(report.suggestedPlugins).toEqual(["@aburi/lang-typescript", "@aburi/framework-nestjs"])
  })

  it("reports a framework it has no plugin for instead of writing a ref nothing resolves", async () => {
    const { report, config } = await initWithDependencies({ svelte: "^4.0.0" })

    expect(config.frameworks).toEqual([])
    expect(report.detectedFrameworks).toContain("svelte")
    expect(report.unmappedFrameworks).toEqual(["svelte"])
    expect(report.unmappedLanguages).toEqual([])
  })

  it("reports a language it has no plugin for, which leaves `languages` empty", async () => {
    await writePackageJson(workspace.root, { name: "app", private: true })
    for (let i = 0; i < 15; i++) {
      await workspace.writeSource(`src/m${i}.py`, "def f():\n    return 1\n")
    }

    const report = await runInit({ cwd: workspace.root })
    const config = JSON.parse(await readFile(report.outputPath, "utf8")) as WrittenConfig

    expect(report.unmappedLanguages).toEqual(["py"])
    expect(config.languages).toEqual([])
    expect(config.components[0]?.languages).toContain("py")
  })
})
