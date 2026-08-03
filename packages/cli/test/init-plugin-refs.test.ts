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
 * `init` used to write detector ids into both, so the loader looked for `@aburi/ts` and
 * the very first `init` -> `scan` sequence failed. These tests pin the split.
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
