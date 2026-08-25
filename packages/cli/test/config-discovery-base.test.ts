import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { detectWorkspaceRoot } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, runCli, runScan } from "../src"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

/**
 * Two anchors that are deliberately different, and the consequences of that.
 *
 * `docs/reference/cli.md` puts `aburi.jsonc` / `aburi.json` discovery at "walking up
 * from `cwd`", so a config in the current package wins over one in an ancestor. Everything
 * *inside* the config — `ignore`, `components[].roots`, relative plugin refs — resolves
 * against the marker-detected workspace root instead, and so does the file discovery the
 * scan performs. A package-local config therefore describes paths relative to a directory
 * above itself, and its scan still covers the whole workspace.
 */

let mono = ""

/** `mono/` is the workspace root (pnpm marker); `mono/pkgs/app` is a package inside it. */
async function makeMonorepo(): Promise<string> {
  await writeFile(resolve(mono, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n", "utf8")
  await writeFile(
    resolve(mono, "package.json"),
    JSON.stringify({ name: "root", private: true }),
    "utf8",
  )
  await mkdir(resolve(mono, "src"), { recursive: true })
  await writeFile(
    resolve(mono, "src/root-only.ts"),
    "export function root() { return 0 }\n",
    "utf8",
  )

  const app = resolve(mono, "pkgs/app")
  await mkdir(resolve(app, "src"), { recursive: true })
  await writeFile(resolve(app, "package.json"), JSON.stringify({ name: "app" }), "utf8")
  // A non-empty body: an empty one is Category-B boilerplate and gets dropped, which
  // would make "zero kept symbols" ambiguous between "config not found" and "dropped".
  await writeFile(resolve(app, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")

  // `detectWorkspaceRoot` takes the *outermost* marker, so a `.git` or `package.json` in an
  // ancestor of the temp directory would silently become the root and these assertions
  // would be measuring the wrong tree.
  expect(await detectWorkspaceRoot({ cwd: app })).toBe(mono)
  return app
}

const TS_CONFIG = {
  $schema: "https://aburi.dev/schema/aburi.config.v1.json",
  languages: ["lang-typescript"],
}

async function writeConfig(dir: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(resolve(dir, "aburi.json"), JSON.stringify({ ...TS_CONFIG, ...extra }), "utf8")
}

beforeEach(async () => {
  mono = await mkdtemp(resolve(tmpdir(), "aburi-cfgbase-"))
})

afterEach(async () => {
  await rm(mono, { recursive: true, force: true })
})

describe("config discovery base", () => {
  it("finds a package-local aburi.json when scanning from that package", async () => {
    const app = await makeMonorepo()
    await writeConfig(app)

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.configSource).toBe(resolve(app, "aburi.json"))
    expect(report.keptSymbols).toBeGreaterThan(0)
    expect(report.skipped).toEqual([])
  })

  it("still walks up to an ancestor config when the package has none", async () => {
    const app = await makeMonorepo()
    await writeConfig(mono)

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.configSource).toBe(resolve(mono, "aburi.json"))
    expect(report.keptSymbols).toBeGreaterThan(0)
    expect(report.skipped).toEqual([])
  })

  it("prefers the nearest config over an ancestor one", async () => {
    const app = await makeMonorepo()
    await writeConfig(mono)
    await writeConfig(app)

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    // Proof by presence: both files are valid and both load the same plugin, so only the
    // reported source distinguishes them. Asserting "zero symbols" from a deliberately
    // plugin-less nearer config would not — an autodetect fallback yields zero as well.
    expect(report.configSource).toBe(resolve(app, "aburi.json"))
  })

  it("reports a null source when no config exists anywhere", async () => {
    const app = await makeMonorepo()

    await expect(
      runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" }),
    ).rejects.toThrow(/no aburi.json was found/)
  })
})

describe("workspace root stays the base for everything inside the config", () => {
  it("resolves a package-local `ignore` glob against the workspace root, not the package", async () => {
    const app = await makeMonorepo()
    // Written by someone standing in `pkgs/app` who means `pkgs/app/src`. It resolves
    // against `mono/`, so it drops `mono/src/root-only.ts` and keeps `pkgs/app/src/a.ts` —
    // the inverse of the intent, which is why the CLI warns when the two directories differ.
    await writeConfig(app, { ignore: ["src/**"] })

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.workspaceRoot).toBe(mono)
    expect(report.keptSymbols).toBe(1)
  })

  it("scans the whole workspace, not just the package the config sits in", async () => {
    const app = await makeMonorepo()
    await writeConfig(app)

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    // `mono/src/root-only.ts` is outside `pkgs/app` and still contributes a Symbol.
    expect(report.keptSymbols).toBe(2)
  })

  it("warns on stderr when the config sits below the workspace root", async () => {
    const app = await makeMonorepo()
    await writeConfig(app)
    const stdout = new MemStream()
    const stderr = new MemStream()

    await runCli({
      argv: ["scan", "--output-dir", resolve(app, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: app,
    })

    expect(stderr.text()).toContain(resolve(app, "aburi.json"))
    expect(stderr.text()).toContain(mono)
  })

  it("stays quiet when the config sits at the workspace root", async () => {
    const app = await makeMonorepo()
    await writeConfig(mono)
    const stdout = new MemStream()
    const stderr = new MemStream()

    await runCli({
      argv: ["scan", "--output-dir", resolve(app, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: app,
    })

    expect(stderr.text()).not.toContain("sits below the workspace root")
  })
})

describe("--config relative paths", () => {
  it("resolves against cwd, like every other path flag", async () => {
    const app = await makeMonorepo()
    await writeFile(resolve(app, "custom.json"), JSON.stringify(TS_CONFIG), "utf8")

    const report = await runScan({
      cwd: app,
      configPath: "./custom.json",
      outputDir: resolve(app, "out"),
      format: "json",
    })

    expect(report.configSource).toBe(resolve(app, "custom.json"))
    expect(report.keptSymbols).toBeGreaterThan(0)
  })

  it("names the cwd-relative path it tried when the file does not exist", async () => {
    const app = await makeMonorepo()

    // The resolved path is the assertion: anchoring to the workspace root instead would
    // report `mono/missing.json`, a file the caller never named.
    await expect(
      runScan({ cwd: app, configPath: "./missing.json", outputDir: resolve(app, "out") }),
    ).rejects.toThrow(resolve(app, "missing.json"))
    await expect(
      runScan({ cwd: app, configPath: "./missing.json", outputDir: resolve(app, "out") }),
    ).rejects.toBeInstanceOf(CliError)
  })
})
