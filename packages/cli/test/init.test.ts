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

describe("aburi init and .gitignore", () => {
  /**
   * Detection reads `.gitignore` now, so `init` can fail where it could not before — and it is
   * the command that writes the config a `respectGitignore: false` would live in. The flag is
   * the whole of the escape hatch, which is why the failure has to name it.
   */
  /**
   * A file the census counts, so the descent has a reason to open the root's rule file at all.
   * The extension is checked before the `.gitignore` question — a candidate no language table
   * knows cannot change a component's languages, so nothing is read for its sake.
   */
  async function writeCountableSource(): Promise<void> {
    await mkdir(resolve(scratch, "apps/api/src"), { recursive: true })
    await writeFile(resolve(scratch, "apps/api/src/a.ts"), "export const a = 1\n", "utf8")
  }

  it("refuses a .gitignore it cannot use, and says how to proceed without it", async () => {
    await makeMinimalPnpmWorkspace()
    await writeCountableSource()
    await writeFile(resolve(scratch, ".gitignore"), `${"a".repeat(5_000)}\n`, "utf8")

    const thrown = await runInit({ cwd: scratch }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    // The machine's fault rather than the config's — there is no config yet to be at fault.
    expect((thrown as CliError).code).toBe("runtime-error")
    expect((thrown as Error).message).toContain("--no-respect-gitignore")
  })

  it("writes the config when told to leave .gitignore alone", async () => {
    await makeMinimalPnpmWorkspace()
    await writeCountableSource()
    await writeFile(resolve(scratch, ".gitignore"), `${"a".repeat(5_000)}\n`, "utf8")

    const report = await runInit({ cwd: scratch, respectGitignore: false })

    expect(report.exitCode).toBe(0)
    expect(JSON.parse(await readFile(report.outputPath, "utf8"))).toHaveProperty("$schema")
  })
})
