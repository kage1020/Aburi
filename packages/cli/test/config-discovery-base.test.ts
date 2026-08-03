import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, runScan } from "../src"

/**
 * `docs/cli-reference.md` puts `aburi.jsonc` / `aburi.json` discovery at "walking up from
 * `cwd`", and `findConfig` implements exactly that. `runScan` however handed it the
 * detected workspace root, so in a monorepo a package-local config was never seen: the
 * run fell through to autodetect, loaded no language plugin, and produced an empty IR at
 * exit 0 — which makes every `--fail-on` gate downstream pass unconditionally.
 *
 * The workspace root keeps coming from marker detection; it is the base for Symbol id
 * paths, not for finding the config.
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
  const app = resolve(mono, "pkgs/app")
  await mkdir(resolve(app, "src"), { recursive: true })
  await writeFile(resolve(app, "package.json"), JSON.stringify({ name: "app" }), "utf8")
  // A non-empty body: an empty one is Category-B boilerplate and gets dropped, which
  // would make "zero kept symbols" ambiguous between "config not found" and "dropped".
  await writeFile(resolve(app, "src/a.ts"), "export function alpha() { return 1 }\n", "utf8")
  return app
}

const TS_CONFIG = JSON.stringify({
  $schema: "https://aburi.dev/schema/aburi.config.v1.json",
  languages: ["lang-typescript"],
})

beforeEach(async () => {
  mono = await mkdtemp(resolve(tmpdir(), "aburi-cfgbase-"))
})

afterEach(async () => {
  await rm(mono, { recursive: true, force: true })
})

describe("config discovery base", () => {
  it("finds a package-local aburi.json when scanning from that package", async () => {
    const app = await makeMonorepo()
    await writeFile(resolve(app, "aburi.json"), TS_CONFIG, "utf8")

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.keptSymbols).toBeGreaterThan(0)
    expect(report.skipped).toEqual([])
  })

  it("still walks up to an ancestor config when the package has none", async () => {
    const app = await makeMonorepo()
    await writeFile(resolve(mono, "aburi.json"), TS_CONFIG, "utf8")

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.keptSymbols).toBeGreaterThan(0)
  })

  it("prefers the nearest config over an ancestor one", async () => {
    const app = await makeMonorepo()
    // The ancestor would load the TypeScript plugin; the nearer config deliberately
    // loads nothing, so "zero symbols" proves which file won.
    await writeFile(resolve(mono, "aburi.json"), TS_CONFIG, "utf8")
    await writeFile(
      resolve(app, "aburi.json"),
      JSON.stringify({ $schema: "https://aburi.dev/schema/aburi.config.v1.json", languages: [] }),
      "utf8",
    )

    const report = await runScan({ cwd: app, outputDir: resolve(app, "out"), format: "json" })

    expect(report.keptSymbols).toBe(0)
  })
})

describe("--config relative paths", () => {
  it("resolves against cwd, like every other path flag", async () => {
    const app = await makeMonorepo()
    await writeFile(resolve(app, "custom.json"), TS_CONFIG, "utf8")

    const report = await runScan({
      cwd: app,
      configPath: "./custom.json",
      outputDir: resolve(app, "out"),
      format: "json",
    })

    expect(report.keptSymbols).toBeGreaterThan(0)
  })

  it("reports the path the user typed when it does not exist", async () => {
    const app = await makeMonorepo()

    await expect(
      runScan({ cwd: app, configPath: "./missing.json", outputDir: resolve(app, "out") }),
    ).rejects.toBeInstanceOf(CliError)
  })
})
