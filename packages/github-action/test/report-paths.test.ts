import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "@aburi/cli"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { parseOutputs, runScript } from "./fixtures/scripts"

/** Runs the script from its root, as the diff step runs it from `working-directory`. */
const scratch = useScratchWorkspace("report-paths")

async function writeReports(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of names) await writeFile(join(dir, name), "{}")
}

async function run(cwd: string, env: Record<string, string>): Promise<Record<string, string>> {
  const { status, stdout } = await runScript("report-paths.mjs", { cwd, env })
  expect(status).toBe(0)
  return parseOutputs(stdout)
}

describe("report-paths.mjs", () => {
  it.each([
    ["both reports, by absolute path", [DIFF_JSON_FILENAME, DIFF_MD_FILENAME], "both", true, true],
    [
      "only the JSON under --format json, whatever else is there",
      [DIFF_JSON_FILENAME, DIFF_MD_FILENAME],
      "json",
      true,
      false,
    ],
    [
      "only the Markdown under --format md, whatever else is there",
      [DIFF_JSON_FILENAME, DIFF_MD_FILENAME],
      "md",
      false,
      true,
    ],
    [
      "the JSON alone when the run wrote it and stopped before the Markdown",
      [DIFF_JSON_FILENAME],
      "both",
      true,
      false,
    ],
    [
      "neither when the CLI stopped before writing, as a plugin error does",
      [],
      "both",
      false,
      false,
    ],
  ])("names %s in a relative output-dir", async (_, written, format, json, md) => {
    const cwd = scratch.root
    await writeReports(join(cwd, "out"), written)
    expect(await run(cwd, { OUTPUT_DIR: "out", FORMAT: format })).toEqual({
      "diff-json-path": json ? join(cwd, "out", DIFF_JSON_FILENAME) : "",
      "diff-md-path": md ? join(cwd, "out", DIFF_MD_FILENAME) : "",
    })
  })

  it("leaves an absolute output-dir as it is, wherever the CLI ran", async () => {
    const cwd = join(scratch.root, "work")
    await mkdir(cwd)
    const outputDir = join(scratch.root, "elsewhere", "aburi")
    await writeReports(outputDir, [DIFF_JSON_FILENAME, DIFF_MD_FILENAME])
    expect(await run(cwd, { OUTPUT_DIR: outputDir, FORMAT: "both" })).toEqual({
      "diff-json-path": join(outputDir, DIFF_JSON_FILENAME),
      "diff-md-path": join(outputDir, DIFF_MD_FILENAME),
    })
  })

  it("does not name a directory standing where a report would be", async () => {
    const cwd = scratch.root
    await mkdir(join(cwd, "out", DIFF_MD_FILENAME), { recursive: true })
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "md" })
    expect(outputs).toEqual({ "diff-json-path": "", "diff-md-path": "" })
  })
})
