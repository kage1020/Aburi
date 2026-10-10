import { chmod, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { CliError, EXIT, runInit } from "../src"
import { loadPinnedConfig, pinConfig } from "../src/config-load"
import { runCliIn } from "./run-cli"
import { CONFIG_SCHEMA_URL, writePackageJson } from "./workspace"

const workspace = useScratchWorkspace("init")

async function pnpmWorkspace(packages = "'apps/*'"): Promise<void> {
  await workspace.writeSource("pnpm-workspace.yaml", `packages:\n  - ${packages}\n`)
  await writePackageJson(workspace.root, { name: "root", private: true })
  await writePackageJson(resolve(workspace.root, "apps/api"), { name: "api", private: true })
}

async function writtenConfig(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

const onPosixAsAUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("aburi init — the config it writes", () => {
  it("writes the detected components under the config schema", async () => {
    await pnpmWorkspace()

    const report = await runInit({ cwd: workspace.root })

    expect(report).toMatchObject({ exitCode: EXIT.SUCCESS, overwrote: false, componentCount: 1 })
    expect(await writtenConfig(report.outputPath)).toMatchObject({
      $schema: CONFIG_SCHEMA_URL,
      components: [expect.objectContaining({ id: "api", roots: ["apps/api"] })],
    })
  })

  it("writes a root component the config loader reads back", async () => {
    await workspace.writeSource("pnpm-workspace.yaml", 'packages:\n  - "."\n')
    await writePackageJson(workspace.root, { name: "storefront", private: true })
    await workspace.writeSource("src/a.ts", "export const a = 1\n")

    const report = await runInit({ cwd: workspace.root })

    expect(await writtenConfig(report.outputPath)).toMatchObject({
      components: [expect.objectContaining({ id: "storefront", roots: ["."] })],
    })
    const loaded = await loadPinnedConfig(await pinConfig(workspace.root, undefined))
    expect(loaded.config.components?.map((c) => c.roots)).toEqual([["."]])
  })

  it("names the plugins to install in a banner the config loader still reads, under --with-suggestions", async () => {
    await pnpmWorkspace()

    const report = await runInit({ cwd: workspace.root, withSuggestions: true })

    const contents = await readFile(report.outputPath, "utf8")
    expect(contents).toContain("// Suggested install: pnpm add -D @aburi/lang-typescript")
    expect(contents).not.toContain("framework-")
    const loaded = await loadPinnedConfig(await pinConfig(workspace.root, undefined))
    expect(loaded.config.languages).toEqual(["lang-typescript"])
  })

  it("writes no banner without --with-suggestions", async () => {
    await pnpmWorkspace()

    const report = await runInit({ cwd: workspace.root })

    expect(await readFile(report.outputPath, "utf8")).not.toContain("Suggested install:")
  })
})

describe("aburi init — a config already there", () => {
  it("refuses to overwrite it without --force", async () => {
    await pnpmWorkspace()
    await workspace.writeSource("aburi.json", "{}")

    const error = await errorFrom(CliError, () => runInit({ cwd: workspace.root }))

    expect(error.code).toBe("input-error")
    expect(error.message).toContain("already exists. Use --force to overwrite")
  })

  it("overwrites it under --force, and says so", async () => {
    await pnpmWorkspace()
    await workspace.writeSource("aburi.json", '{"$schema": "old"}')

    const report = await runInit({ cwd: workspace.root, force: true })

    expect(report.overwrote).toBe(true)
    expect(await readFile(report.outputPath, "utf8")).not.toContain('"old"')
  })
})

describe("aburi init — a .gitignore it cannot use", () => {
  it("refuses at exit 1, naming the flag that leaves it alone", async () => {
    await pnpmWorkspace()
    await workspace.writeSource("apps/api/src/a.ts", "export const a = 1\n")
    await workspace.writeSource(".gitignore", `${"a".repeat(5_000)}\n`)

    const error = await errorFrom(CliError, () => runInit({ cwd: workspace.root }))

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain("--no-respect-gitignore")
  })

  it("writes the config when told to leave .gitignore alone", async () => {
    await pnpmWorkspace()
    await workspace.writeSource("apps/api/src/a.ts", "export const a = 1\n")
    await workspace.writeSource(".gitignore", `${"a".repeat(5_000)}\n`)

    const report = await runInit({ cwd: workspace.root, respectGitignore: false })

    expect(await writtenConfig(report.outputPath)).toHaveProperty("$schema")
  })
})

describe("aburi init --output", () => {
  it("creates the directories the path names", async () => {
    await pnpmWorkspace()

    const report = await runInit({ cwd: workspace.root, output: "generated/config/aburi.json" })

    expect(report.outputPath).toBe(resolve(workspace.root, "generated/config/aburi.json"))
    expect(await writtenConfig(report.outputPath)).toHaveProperty("$schema")
  })

  it("names the path and the remedy when a file stands where a directory would go", async () => {
    await pnpmWorkspace()
    await workspace.writeSource("generated", "not a directory\n")

    const error = await errorFrom(CliError, () =>
      runInit({ cwd: workspace.root, output: "generated/aburi.json" }),
    )

    expect(error.code).toBe("input-error")
    expect(error.message).toContain(resolve(workspace.root, "generated/aburi.json"))
    expect(error.message).toContain("--output")
  })

  it.each([
    false,
    true,
  ])("names a directory on the path itself, --force %s or not", async (force) => {
    await pnpmWorkspace()
    await mkdir(resolve(workspace.root, "generated"))

    const error = await errorFrom(CliError, () =>
      runInit({ cwd: workspace.root, output: "generated", force }),
    )

    expect(error.code).toBe("input-error")
    expect(error.message).toContain(resolve(workspace.root, "generated"))
    expect(error.message).toContain("is a directory")
    expect(error.message).not.toContain("--force")
  })

  onPosixAsAUser("reports a directory it may not write to as its runtime failure", async () => {
    await pnpmWorkspace()
    const locked = resolve(workspace.root, "locked")
    await mkdir(locked)
    await chmod(locked, 0o500)

    const error = await errorFrom(CliError, () =>
      runInit({ cwd: workspace.root, output: "locked/aburi.json" }),
    ).finally(() => chmod(locked, 0o700))

    expect(error.code).toBe("runtime-error")
    expect(error.message).toContain(
      `aburi init could not write the config to ${resolve(locked, "aburi.json")}`,
    )
    expect(error.message).toContain("EACCES")
    expect(error.cause).toMatchObject({ code: "EACCES" })
  })
})

describe("aburi init — a package.json on the way to the workspace root", () => {
  const TRAILING_COMMA = '{ "name": "broken", }'

  it.each([
    ["the root's own", "", true],
    ["a marker-less package's own", "pkg", false],
  ])("reports %s unparseable manifest at exit 1", async (_, below, gitRoot) => {
    const directory = resolve(workspace.root, below)
    if (gitRoot) await mkdir(resolve(directory, ".git"), { recursive: true })
    await workspace.writeSource(`${below === "" ? "" : `${below}/`}package.json`, TRAILING_COMMA)

    const { code, stderr } = await runCliIn(directory, ["init"])

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("Failed to parse JSON at")
    expect(stderr).toContain(resolve(directory, "package.json"))
  })

  it("runs anyway when the unparseable manifest is above the workspace root", async () => {
    const repo = resolve(workspace.root, "repo")
    await mkdir(resolve(repo, ".git"), { recursive: true })
    await workspace.writeSource("package.json", TRAILING_COMMA)

    expect(await runInit({ cwd: repo })).toMatchObject({ exitCode: 0, workspaceRoot: repo })
  })

  onPosixAsAUser("runs anyway when a manifest above the root cannot be read", async () => {
    const repo = resolve(workspace.root, "repo")
    await mkdir(resolve(repo, ".git"), { recursive: true })
    await writePackageJson(workspace.root, { name: "outer" })
    const locked = resolve(workspace.root, "package.json")
    await chmod(locked, 0o000)

    const report = await runInit({ cwd: repo }).finally(() => chmod(locked, 0o600))

    expect(report).toMatchObject({ exitCode: 0, workspaceRoot: repo })
  })
})
