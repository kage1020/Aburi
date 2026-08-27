import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScan } from "../src"
import { CliError } from "../src/errors"
import { STUB_PLUGIN } from "./stub-language"

/**
 * `Component.languages` is decided by a census of file extensions, and the census used to run
 * against a different set of files from the one the scan reads: its own short exclusion list,
 * and no `.gitignore`. `aburi scan` is the caller that knows the whole drop decision, so it is
 * the one place where the two can be made to agree — and nothing asserted that it hands the
 * decision over. Dropping either argument leaves every test in `@aburi/core` passing.
 */

let workRoot = ""

async function writeFileAt(rel: string, content = "x"): Promise<void> {
  const abs = resolve(workRoot, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

/** Enough files of one extension to clear the ten-file, five-percent frequency threshold. */
async function writeLanguage(directory: string, extension: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await writeFileAt(join(directory, `f${index}${extension}`), "export const x = 1\n")
  }
}

async function scannedLanguages(config: Record<string, unknown>): Promise<readonly string[]> {
  await writeFile(
    resolve(workRoot, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      ...config,
    }),
    "utf8",
  )
  const report = await runScan({ cwd: workRoot, format: "json" })
  if (report.irPath === null) throw new Error("expected an IR")
  const ir = JSON.parse(await readFile(report.irPath, "utf8")) as IR
  expect(ir.components).toHaveLength(1)
  return ir.components[0]?.languages ?? []
}

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), "aburi-component-languages-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe("aburi scan hands the census its own drop decision", () => {
  it("does not label a component with a language only its git-ignored files are written in", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await scannedLanguages({})).toEqual(["ts"])
  })

  it("counts the git-ignored files again when the config turns the rule off", async () => {
    // The other direction of the same hand-off: a run that says to ignore `.gitignore` must
    // see those files here too, or the census and the scan disagree the other way.
    await writeLanguage("src", ".ts")
    await writeLanguage("generated", ".py")
    await writeFileAt(".gitignore", "generated/\n")

    expect(await scannedLanguages({ respectGitignore: false })).toEqual(["py", "ts"])
  })

  it("does not label a component with a language only config.ignore's files are written in", async () => {
    await writeLanguage("src", ".ts")
    await writeLanguage("fixtures", ".py")

    expect(await scannedLanguages({ ignore: ["fixtures/**"] })).toEqual(["ts"])
  })
})

/**
 * The stub plugin, given a file-drop glob of its own.
 *
 * The only shipped language plugin declares the three TypeScript declaration globs, and all
 * three are already core patterns — so `languageFileDropPatterns` contributes nothing for it, and deleting
 * the spread that carries it is invisible to any fixture built on `lang-typescript`. It stops
 * being inert the moment a plugin names a pattern outside the core list.
 */
const DROPPING_PLUGIN = STUB_PLUGIN.replace(
  '  fileExtensions: [".stub"],',
  '  fileExtensions: [".stub"],\n  fileDropPatterns: ["**/legacy/**"],',
)

describe("a language plugin's own drop globs reach the census", () => {
  it("does not count a directory only the plugin excludes", async () => {
    await writeFile(resolve(workRoot, "lang-stub.mjs"), DROPPING_PLUGIN, "utf8")
    await writeFileAt("package.json", JSON.stringify({ name: "fixture", private: true }))
    // One file the plugin claims, so the scan produces an IR at all.
    await writeFileAt(join("src", "a.stub"), "x")
    await writeLanguage("src", ".py")
    await writeLanguage("legacy", ".rs")

    expect(await scannedLanguages({ languages: ["./lang-stub.mjs"] })).toEqual(["py"])
  })
})

describe("what a failed component resolution exits with", () => {
  /**
   * Detection walks the workspace and opens rule files now, so this path spans real IO —
   * and `cli-spec.md` §9 keeps exit 2 for bad input and exit 1 for a runtime failure. Reporting
   * an unreadable `.gitignore` as a config error sends the reader through `aburi.json` for a
   * mistake that is not there.
   */
  it("exits with a runtime failure when a rule file cannot be used", async () => {
    await writeLanguage("src", ".ts")
    await writeFileAt(".gitignore", `${"a".repeat(5_000)}\n`)

    const thrown = await scannedLanguages({}).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("runtime-error")
  })

  it("keeps the input error for a manifest that cannot be parsed", async () => {
    // A manifest that is present and unreadable is the workspace being wrong, so §9's exit 2
    // is what tells the reader to go and fix a file. Nothing put that code on the config side
    // before, so even the pnpm manifest's own refusal exited 1.
    await writeLanguage("src", ".ts")
    await writeFileAt("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n')
    await writeFileAt("apps/billing/package.json", "{ broken")

    const thrown = await scannedLanguages({}).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
    expect((thrown as Error).message).toContain("package.json")
  })

  it("keeps the input error for a component root the Document cannot hold", async () => {
    await writeLanguage("src", ".ts")

    const thrown = await scannedLanguages({
      components: [{ id: "app", roots: ["../outside"] }],
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("config-error")
  })
})
