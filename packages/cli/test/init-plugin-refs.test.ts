import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runInit } from "../src"

/**
 * `aburi.json` uses two different vocabularies under the same key name:
 *
 * - top-level `languages` / `frameworks` hold **plugin refs** (`PluginRef`), which the
 *   plugin loader resolves as module specifiers;
 * - `components[].languages` holds **language ids** (`LanguageId`, `^[a-z][a-z0-9]*$`),
 *   which cannot express a hyphenated manifest name.
 *
 * A detector id in the top-level array sends the loader looking for `@aburi/ts`, and a
 * manifest name inside `components[]` fails the `LanguageId` pattern, so neither field
 * tolerates the other's vocabulary. These tests pin the split at both ends.
 */

let scratch = ""

async function makeWorkspace(dependencies: Record<string, string>): Promise<void> {
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "app", private: true, dependencies }),
    "utf8",
  )
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/a.ts"), "export function alpha() {}\n", "utf8")
}

async function readConfig(path: string): Promise<{
  languages: string[]
  frameworks: string[]
  components: { languages: string[]; frameworks: string[] }[]
}> {
  const raw = await readFile(path, "utf8")
  return JSON.parse(raw) as {
    languages: string[]
    frameworks: string[]
    components: { languages: string[]; frameworks: string[] }[]
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-init-refs-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runInit — top-level plugin refs", () => {
  it("writes manifest names, not language ids, under `languages`", async () => {
    await makeWorkspace({})
    const report = await runInit({ cwd: scratch })
    const config = await readConfig(report.outputPath)

    expect(config.languages).toEqual(["lang-typescript"])
  })

  it("writes framework plugin names for every framework it has a plugin for", async () => {
    await makeWorkspace({ "@nestjs/core": "^10.0.0" })
    const report = await runInit({ cwd: scratch })
    const config = await readConfig(report.outputPath)

    expect(config.frameworks).toEqual(["framework-nestjs"])
  })

  it("keeps the LanguageId vocabulary inside components[]", async () => {
    await makeWorkspace({ "@nestjs/core": "^10.0.0" })
    const report = await runInit({ cwd: scratch })
    const config = await readConfig(report.outputPath)

    const [component] = config.components
    expect(component).toBeDefined()
    expect(component?.languages).toContain("ts")
    expect(component?.frameworks).toContain("nestjs")
    for (const id of component?.languages ?? []) expect(id).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("omits detected frameworks that have no plugin instead of emitting an unresolvable ref", async () => {
    await makeWorkspace({ svelte: "^4.0.0" })
    const report = await runInit({ cwd: scratch })
    const config = await readConfig(report.outputPath)

    expect(config.frameworks).toEqual([])
    expect(report.detectedFrameworks).toContain("svelte")
  })

  it("reports the detector vocabulary unchanged so the CLI summary stays human-facing", async () => {
    await makeWorkspace({ "@nestjs/core": "^10.0.0" })
    const report = await runInit({ cwd: scratch })

    expect(report.detectedLanguages).toContain("ts")
    expect(report.detectedFrameworks).toContain("nestjs")
  })
})

describe("runInit — detected ids with no first-party plugin", () => {
  it("reports an unmapped framework without emitting an unresolvable ref", async () => {
    await makeWorkspace({ svelte: "^4.0.0" })
    const report = await runInit({ cwd: scratch })

    expect(report.unmappedFrameworks).toEqual(["svelte"])
    expect(report.unmappedLanguages).toEqual([])
  })

  it("reports an unmapped language, which is what leaves `languages` empty", async () => {
    // Ten-plus files of one extension is what the detector needs before it records the
    // language at all (`LANGUAGE_MIN_FILES`), so a smaller sample would fall back to `ts`
    // and never exercise this branch.
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "app", private: true }),
      "utf8",
    )
    await mkdir(resolve(scratch, "src"), { recursive: true })
    for (let i = 0; i < 15; i++) {
      await writeFile(resolve(scratch, `src/m${i}.py`), "def f():\n    return 1\n", "utf8")
    }

    const report = await runInit({ cwd: scratch })
    const config = await readConfig(report.outputPath)

    expect(report.detectedLanguages).toContain("py")
    expect(report.unmappedLanguages).toEqual(["py"])
    expect(config.languages).toEqual([])
    // The detector's own vocabulary stays accurate; only the plugin-ref array is empty.
    expect(config.components[0]?.languages).toContain("py")
  })
})

describe("runInit --with-suggestions", () => {
  it("suggests the language plugin, which the next scan cannot run without", async () => {
    await makeWorkspace({})
    const report = await runInit({ cwd: scratch, withSuggestions: true })

    expect(report.suggestedPlugins).toContain("@aburi/lang-typescript")
  })

  it("lists the language plugin before framework plugins", async () => {
    await makeWorkspace({ "@nestjs/core": "^10.0.0" })
    const report = await runInit({ cwd: scratch, withSuggestions: true })

    expect(report.suggestedPlugins).toEqual(["@aburi/lang-typescript", "@aburi/framework-nestjs"])
  })
})
