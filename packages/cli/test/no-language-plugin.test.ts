import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, runScan } from "../src"

/**
 * A scan with no language plugin can parse nothing, so the only IR it could write has zero
 * Symbols and an empty `workspace.languages` — a document the IR schema rejects
 * (`minItems: 1`). Succeeding at that is worse than failing: two such IRs diff to
 * `+0 -0 ~0`, so every `--fail-on` gate downstream passes regardless of what changed.
 *
 * The state is reachable without user error. `init` writes no `languages` entry for a
 * project whose language has no first-party plugin, which today is every language but
 * TypeScript.
 */

let scratch = ""

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      ...config,
    }),
    "utf8",
  )
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-nolang-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "nolang-fixture", private: true }),
    "utf8",
  )
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/m.py"), "def f():\n    return 1\n", "utf8")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — no language plugin", () => {
  it("refuses an empty languages list instead of writing a schema-invalid IR", async () => {
    await writeConfig({ languages: [] })

    await expect(
      runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" }),
    ).rejects.toBeInstanceOf(CliError)
  })

  it("refuses a config that omits languages entirely", async () => {
    await writeConfig({})

    await expect(
      runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" }),
    ).rejects.toThrow(/No language plugin is configured/)
  })

  it("names the config it read, so the user knows which file to edit", async () => {
    await writeConfig({ languages: [] })

    await expect(
      runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" }),
    ).rejects.toThrow(resolve(scratch, "aburi.json"))
  })

  it("says no config was found when discovery came up empty", async () => {
    await expect(
      runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" }),
    ).rejects.toThrow(/no aburi.json was found/)
  })

  it("proceeds once a language plugin is configured", async () => {
    // And once there is something for it to read. `src/m.py` is filtered out at discovery
    // because no loaded plugin claims `.py`, so without this the scan discovers nothing and
    // gates on coverage instead — a different refusal with a different fix.
    await writeFile(resolve(scratch, "src/m.ts"), "export const m = 1\n", "utf8")
    await writeConfig({ languages: ["lang-typescript"] })

    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })

    expect(report.exitCode).toBe(0)
    expect(report.irPath).not.toBeNull()
  })
})
