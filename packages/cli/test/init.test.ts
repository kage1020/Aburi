import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, runCli, runInit } from "../src"
import { resolveConfig } from "../src/config-load"
import { MemStream } from "./fixtures"

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
    expect(parsed.$schema).toBe("https://aburi.kage1020.com/schema/aburi.config.v1.json")
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

describe("a workspace that declares its own root", () => {
  /**
   * `packages: ['.']` puts `roots: ["."]` in the config `init` writes, which no other manager
   * path produces. The config it writes has to be one its own loader accepts, so the two
   * halves are exercised in one test rather than either alone.
   */
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

describe("CL25 — --output under directories that do not exist", () => {
  it("creates them and writes the config there", async () => {
    await makeMinimalPnpmWorkspace()

    const report = await runInit({ cwd: scratch, output: "generated/config/aburi.json" })

    expect(report.exitCode).toBe(0)
    expect(report.outputPath).toBe(resolve(scratch, "generated/config/aburi.json"))
    expect(JSON.parse(await readFile(report.outputPath, "utf8"))).toHaveProperty("$schema")
  })
})

describe("CL27 — an --output that cannot hold a file", () => {
  it("names the path and the remedy instead of surfacing the errno", async () => {
    await makeMinimalPnpmWorkspace()
    await writeFile(resolve(scratch, "generated"), "not a directory\n", "utf8")

    const thrown = await runInit({ cwd: scratch, output: "generated/aburi.json" }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    // The caller's path rather than the machine's refusal — cli-spec.md puts an
    // --output that cannot be written at exit 2.
    expect((thrown as CliError).code).toBe("input-error")
    expect((thrown as Error).message).toContain(resolve(scratch, "generated/aburi.json"))
    expect((thrown as Error).message).toContain("--output")
  })

  // Both settings of --force, because the overwrite guard stands in front of the write and
  // sees the directory first. Offering --force there would be advice whose only destination is
  // the refusal below it.
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

// The permission has to actually deny the write, which it does not for root.
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

    // Before the assertions, so a failing one still leaves the scratch directory removable.
    await chmod(locked, 0o700)

    // Wrapped rather than rethrown raw: the errno alone named the path and nothing else, so
    // the message now says which command and which artefact, and keeps the errno after it.
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
    expect((thrown as Error).message).toContain("aburi init could not write the config to ")
    expect((thrown as Error).message).toContain(resolve(scratch, "locked/aburi.json"))
    expect((thrown as Error).message).toContain("EACCES")
    expect((thrown as Error).cause).toMatchObject({ code: "EACCES" })
  })
})

/**
 * A `package.json` between the working directory and the filesystem root that will not read,
 * and what `aburi init` does about it.
 *
 * This command resolves its workspace root through the shared `resolveWorkspaceRoot` rather
 * than a private `catch { return resolve(cwd) }`, which changed who reports such a file and
 * under which code. Four cases, because a manifest on that path is opened by the marker walk,
 * by `detectManagers`, or by neither — and the answer follows whichever of them met it.
 * Pinned end to end, because what matters is the pair (what the process returns, what the
 * reader is told) and neither half is decided in one place.
 */
describe("aburi init — a package.json on the way to the workspace root", () => {
  /**
   * Through the CLI wrapper for the two failing cases, because what they produce is a thrown
   * error and the claim being pinned is the exit code it becomes. The succeeding cases read
   * `InitReport` directly, where the root that was settled on is visible as well as the code.
   */
  async function initViaCli(cwd: string): Promise<{ code: number; stderr: string }> {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({ argv: ["init"], stdout, stderr, env: {}, cwd })
    return { code, stderr: stderr.text() }
  }

  /** A workspace root that needs nothing read to be one, so only the extra file is in play. */
  async function makeGitRoot(dir: string): Promise<void> {
    await mkdir(resolve(dir, ".git"), { recursive: true })
  }

  const TRAILING_COMMA = '{ "name": "broken", }'

  it("reports the root's own unparseable package.json as a runtime failure", async () => {
    // The marker walk never opens it: `.git` answers "this is the root" first and the walk
    // stops at the first marker it finds. The trailing comma waits for `detectManagers`, which
    // reads the root manifest for a `workspaces` field and raises on its own account — so this
    // case is untouched by which code resolves the root, and exits where it always did.
    await makeGitRoot(scratch)
    await writeFile(resolve(scratch, "package.json"), TRAILING_COMMA, "utf8")

    const { code, stderr } = await initViaCli(scratch)

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("Failed to parse JSON at")
    expect(stderr).toContain(resolve(scratch, "package.json"))
  })

  it("reports a marker-less package's own unparseable manifest the same way", async () => {
    // Nothing above it carries a marker either, so the walk ends in `workspace-root-not-found`
    // — the one failure `resolveWorkspaceRoot` absorbs — and the package becomes its own
    // workspace. `detectManagers` then opens the same file and raises, which is why a broken
    // manifest is still reported here rather than absorbed along with the missing root.
    const pkg = resolve(scratch, "pkg")
    await mkdir(pkg, { recursive: true })
    await writeFile(resolve(pkg, "package.json"), TRAILING_COMMA, "utf8")

    const { code, stderr } = await initViaCli(pkg)

    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("Failed to parse JSON at")
    expect(stderr).toContain(resolve(pkg, "package.json"))
  })

  it("runs anyway when the unparseable manifest is above the workspace root", async () => {
    // A `$HOME/package.json` left on a shared machine. The walk only opened it because it
    // climbs to the filesystem root; it is not part of this workspace, and stopping over it
    // would hand the user a path they do not recognise with no way around it.
    const outer = resolve(scratch, "outer")
    const repo = resolve(outer, "repo")
    await makeGitRoot(repo)
    await writeFile(resolve(outer, "package.json"), TRAILING_COMMA, "utf8")

    const report = await runInit({ cwd: repo })

    expect(report.exitCode).toBe(0)
    expect(report.workspaceRoot).toBe(repo)
  })

  // The permission has to actually deny the read, which it does not for root.
  onPosixAsAUser("runs anyway when a manifest above the root cannot be read", async () => {
    // Same directory as the case above, refused by the filesystem rather than by the parser —
    // a CI container that cannot read what is above its checkout. The two arrive here as
    // different classes of thrown value and must not be told apart on the way out.
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

    // Before the assertions, so a failing one still leaves the scratch directory removable.
    await chmod(locked, 0o600)

    expect(outcome).not.toBeInstanceOf(Error)
    expect(outcome).toMatchObject({ exitCode: 0, workspaceRoot: repo })
  })
})
