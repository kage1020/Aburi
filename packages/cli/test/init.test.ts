import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, runInit } from "../src"

/**
 * CL4 / CL5 — `aburi init` file-handling. Each test creates a scratch workspace so
 * autodetect has something to attach to and the write path is isolated.
 */

let scratch = ""

async function makeMinimalPnpmWorkspace(): Promise<void> {
  await writeFile(resolve(scratch, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf8")
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "root", private: true }),
    "utf8",
  )
  await mkdir(resolve(scratch, "apps/api"), { recursive: true })
  await writeFile(
    resolve(scratch, "apps/api/package.json"),
    JSON.stringify({ name: "api", private: true }),
    "utf8",
  )
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-init-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runInit — happy path", () => {
  it("writes aburi.json with detected components", async () => {
    await makeMinimalPnpmWorkspace()
    const report = await runInit({ cwd: scratch })
    expect(report.exitCode).toBe(0)
    const contents = await readFile(report.outputPath, "utf8")
    const parsed = JSON.parse(contents) as { $schema: string; components: unknown[] }
    expect(parsed.$schema).toBe("https://aburi.dev/schema/aburi.config.v1.json")
    expect(parsed.components.length).toBeGreaterThan(0)
  })
})

describe("CL4 — existing aburi.json without --force", () => {
  it("throws CliError", async () => {
    await makeMinimalPnpmWorkspace()
    await writeFile(resolve(scratch, "aburi.json"), "{}", "utf8")
    await expect(runInit({ cwd: scratch })).rejects.toBeInstanceOf(CliError)
  })
})

describe("CL5 — --force overwrites", () => {
  it("succeeds and reports overwrote:true", async () => {
    await makeMinimalPnpmWorkspace()
    await writeFile(resolve(scratch, "aburi.json"), '{"$schema": "old"}', "utf8")
    const report = await runInit({ cwd: scratch, force: true })
    expect(report.exitCode).toBe(0)
    expect(report.overwrote).toBe(true)
    const contents = await readFile(report.outputPath, "utf8")
    expect(contents).not.toContain('"old"')
  })
})

describe("--with-suggestions", () => {
  it("names the language plugin even when no framework is detected", async () => {
    await makeMinimalPnpmWorkspace()
    const report = await runInit({ cwd: scratch, withSuggestions: true })
    const contents = await readFile(report.outputPath, "utf8")
    // The language plugin is what the next `aburi scan` refuses to run without, so it is
    // suggested unconditionally; the minimal workspace pulls in no framework.
    expect(contents).toContain("Suggested install: pnpm add -D @aburi/lang-typescript")
    expect(contents).not.toContain("framework-")
  })

  it("emits no banner when the flag is absent", async () => {
    await makeMinimalPnpmWorkspace()
    const report = await runInit({ cwd: scratch })
    const contents = await readFile(report.outputPath, "utf8")
    expect(contents).not.toContain("Suggested install:")
  })
})
