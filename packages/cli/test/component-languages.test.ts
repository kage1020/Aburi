import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runScan } from "../src"

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
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
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
