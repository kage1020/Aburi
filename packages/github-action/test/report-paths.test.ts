import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME } from "@aburi/cli"
import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "report-paths.mjs")

const workspaces: string[] = []

afterAll(async () => {
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A directory to run the script from, as the diff step runs it from `working-directory`. */
async function workingDirectory(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "aburi-report-paths-")))
  workspaces.push(dir)
  return dir
}

async function writeReports(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of names) await writeFile(join(dir, name), "{}")
}

async function run(cwd: string, env: Record<string, string>): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  })
  const outputs: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return outputs
}

describe("report-paths.mjs", () => {
  it("names a relative output-dir's reports by absolute path", async () => {
    const cwd = await workingDirectory()
    await writeReports(join(cwd, "out"), [DIFF_JSON_FILENAME, DIFF_MD_FILENAME])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "both" })
    expect(outputs).toEqual({
      "diff-json-path": join(cwd, "out", DIFF_JSON_FILENAME),
      "diff-md-path": join(cwd, "out", DIFF_MD_FILENAME),
    })
  })

  it("leaves an absolute output-dir as it is, wherever the CLI ran", async () => {
    // An absolute output-dir must come back untouched, whatever directory the script ran in.
    const cwd = await workingDirectory()
    const elsewhere = await workingDirectory()
    const outputDir = join(elsewhere, "aburi")
    await writeReports(outputDir, [DIFF_JSON_FILENAME, DIFF_MD_FILENAME])
    const outputs = await run(cwd, { OUTPUT_DIR: outputDir, FORMAT: "both" })
    expect(outputs["diff-md-path"]).toBe(join(outputDir, DIFF_MD_FILENAME))
    expect(outputs["diff-json-path"]).toBe(join(outputDir, DIFF_JSON_FILENAME))
    expect(isAbsolute(outputs["diff-md-path"] ?? "")).toBe(true)
  })

  it("gives empty paths when the CLI stopped before writing, as a plugin error does", async () => {
    const cwd = await workingDirectory()
    await mkdir(join(cwd, "out"))
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "both" })
    expect(outputs).toEqual({ "diff-json-path": "", "diff-md-path": "" })
  })

  it("names only the JSON under --format json, whatever else is there", async () => {
    const cwd = await workingDirectory()
    await writeReports(join(cwd, "out"), [DIFF_JSON_FILENAME, DIFF_MD_FILENAME])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "json" })
    expect(outputs).toEqual({
      "diff-json-path": join(cwd, "out", DIFF_JSON_FILENAME),
      "diff-md-path": "",
    })
  })

  it("names only the Markdown under --format md, whatever else is there", async () => {
    const cwd = await workingDirectory()
    await writeReports(join(cwd, "out"), [DIFF_JSON_FILENAME, DIFF_MD_FILENAME])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "md" })
    expect(outputs).toEqual({
      "diff-json-path": "",
      "diff-md-path": join(cwd, "out", DIFF_MD_FILENAME),
    })
  })

  it("names the JSON alone when the run wrote it and stopped before the Markdown", async () => {
    const cwd = await workingDirectory()
    await writeReports(join(cwd, "out"), [DIFF_JSON_FILENAME])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "both" })
    expect(outputs).toEqual({
      "diff-json-path": join(cwd, "out", DIFF_JSON_FILENAME),
      "diff-md-path": "",
    })
  })

  it("does not name a directory standing where a report would be", async () => {
    const cwd = await workingDirectory()
    await mkdir(join(cwd, "out", DIFF_MD_FILENAME), { recursive: true })
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "md" })
    expect(outputs).toEqual({ "diff-json-path": "", "diff-md-path": "" })
  })
})
