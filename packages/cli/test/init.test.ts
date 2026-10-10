import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, runCli, runInit } from "../src"
import { resolveConfig } from "../src/config-load"
import { MemStream } from "./fixtures"

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
    expect(parsed.$schema).toBe("https://aburi.kage1020.com/schema/aburi.config.v1.json")
    expect(parsed.components.length).toBeGreaterThan(0)
  })
})

describe("existing aburi.json without --force", () => {
  it("throws CliError", async () => {
    await makeMinimalPnpmWorkspace()
    await writeFile(resolve(scratch, "aburi.json"), "{}", "utf8")
    await expect(runInit({ cwd: scratch })).rejects.toBeInstanceOf(CliError)
  })
})

describe("--force overwrites", () => {
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

describe("a workspace that declares its own root", () => {
  it("writes a root component the config loader reads back", async () => {
    await writeFile(resolve(scratch, "pnpm-workspace.yaml"), 'packages:\n  - "."\n', "utf8")
    await writeFile(
      resolve(scratch, "package.json"),
      JSON.stringify({ name: "storefront", private: true }),
      "utf8",
    )
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src/a.ts"), "export const a = 1\n", "utf8")

    const report = await runInit({ cwd: scratch })
    expect(report.exitCode).toBe(0)

    const written = JSON.parse(await readFile(report.outputPath, "utf8")) as {
      components: { id: string; roots: string[] }[]
    }
    expect(written.components).toHaveLength(1)
    expect(written.components[0]).toMatchObject({ id: "storefront", roots: ["."] })

    const loaded = await resolveConfig(scratch, undefined)
    expect(loaded.found).toBe(true)
    expect(loaded.config.components?.map((c) => c.roots)).toEqual([["."]])
  })
})

describe("aburi init and .gitignore", () => {
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

describe("--output under directories that do not exist", () => {
  it("creates them and writes the config there", async () => {
    await makeMinimalPnpmWorkspace()

    const report = await runInit({ cwd: scratch, output: "generated/config/aburi.json" })

    expect(report.exitCode).toBe(0)
    expect(report.outputPath).toBe(resolve(scratch, "generated/config/aburi.json"))
    expect(JSON.parse(await readFile(report.outputPath, "utf8"))).toHaveProperty("$schema")
  })
})

describe("an --output that cannot hold a file", () => {
  it("names the path and the remedy instead of surfacing the errno", async () => {
    await makeMinimalPnpmWorkspace()
    await writeFile(resolve(scratch, "generated"), "not a directory\n", "utf8")

    const thrown = await runInit({ cwd: scratch, output: "generated/aburi.json" }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("input-error")
    expect((thrown as Error).message).toContain(resolve(scratch, "generated/aburi.json"))
    expect((thrown as Error).message).toContain("--output")
  })

  it.each([false, true])("names a directory on the path itself (--force %s)", async (force) => {
    await makeMinimalPnpmWorkspace()
    await mkdir(resolve(scratch, "generated"), { recursive: true })

    const thrown = await runInit({ cwd: scratch, output: "generated", force }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("input-error")
    expect((thrown as Error).message).toContain(resolve(scratch, "generated"))
    expect((thrown as Error).message).toContain("is a directory")
    expect((thrown as Error).message).not.toContain("--force")
  })
})

const onPosixAsAUser = it.skipIf(process.platform === "win32" || process.getuid?.() === 0)

describe("an --output failure that is not the path's shape", () => {
  onPosixAsAUser("is the command's runtime failure, not an input error", async () => {
    await makeMinimalPnpmWorkspace()
    const locked = resolve(scratch, "locked")
    await mkdir(locked, { recursive: true })
    await chmod(locked, 0o500)

    const thrown = await runInit({ cwd: scratch, output: "locked/aburi.json" }).then(
      () => null,
      (error: unknown) => error,
    )

    await chmod(locked, 0o700)

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
    expect((thrown as Error).message).toContain("aburi init could not write the config to ")
    expect((thrown as Error).message).toContain(resolve(scratch, "locked/aburi.json"))
    expect((thrown as Error).message).toContain("EACCES")
    expect((thrown as Error).cause).toMatchObject({ code: "EACCES" })
  })
})

describe("aburi init — a package.json on the way to the workspace root", () => {
  async function initViaCli(cwd: string): Promise<{ code: number; stderr: string }> {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({ argv: ["init"], stdout, stderr, env: {}, cwd })
    return { code, stderr: stderr.text() }
  }

  async function makeGitRoot(dir: string): Promise<void> {
    await mkdir(resolve(dir, ".git"), { recursive: true })
  }

  const TRAILING_COMMA = '{ "name": "broken", }'

  it("reports the root's own unparseable package.json as a runtime failure", async () => {
    await makeGitRoot(scratch)
    await writeFile(resolve(scratch, "package.json"), TRAILING_COMMA, "utf8")

    const { code, stderr } = await initViaCli(scratch)

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("Failed to parse JSON at")
    expect(stderr).toContain(resolve(scratch, "package.json"))
  })

  it("reports a marker-less package's own unparseable manifest the same way", async () => {
    const pkg = resolve(scratch, "pkg")
    await mkdir(pkg, { recursive: true })
    await writeFile(resolve(pkg, "package.json"), TRAILING_COMMA, "utf8")

    const { code, stderr } = await initViaCli(pkg)

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("Failed to parse JSON at")
    expect(stderr).toContain(resolve(pkg, "package.json"))
  })

  it("runs anyway when the unparseable manifest is above the workspace root", async () => {
    const outer = resolve(scratch, "outer")
    const repo = resolve(outer, "repo")
    await makeGitRoot(repo)
    await writeFile(resolve(outer, "package.json"), TRAILING_COMMA, "utf8")

    const report = await runInit({ cwd: repo })

    expect(report.exitCode).toBe(0)
    expect(report.workspaceRoot).toBe(repo)
  })

  onPosixAsAUser("runs anyway when a manifest above the root cannot be read", async () => {
    const outer = resolve(scratch, "outer")
    const repo = resolve(outer, "repo")
    await makeGitRoot(repo)
    const locked = resolve(outer, "package.json")
    await writeFile(locked, JSON.stringify({ name: "outer" }), "utf8")
    await chmod(locked, 0o000)

    const outcome = await runInit({ cwd: repo }).then(
      (report) => report,
      (error: unknown) => error,
    )

    await chmod(locked, 0o600)

    expect(outcome).not.toBeInstanceOf(Error)
    expect(outcome).toMatchObject({ exitCode: 0, workspaceRoot: repo })
  })
})
