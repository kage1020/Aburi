import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
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

/**
 * Run as a process from `cwd`, with the environment spelled out, and read stdout back the way
 * the runner reads `$GITHUB_OUTPUT`.
 */
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
    await writeReports(join(cwd, "out"), ["diff.json", "diff.md"])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "both" })
    expect(outputs).toEqual({
      "diff-json-path": join(cwd, "out", "diff.json"),
      "diff-md-path": join(cwd, "out", "diff.md"),
    })
  })

  it("leaves an absolute output-dir as it is, wherever the CLI ran", async () => {
    // The case that failed: with `working-directory: .` the comment step was handed
    // `.//home/runner/work/_temp/aburi/diff.md`.
    const cwd = await workingDirectory()
    const elsewhere = await workingDirectory()
    const outputDir = join(elsewhere, "aburi")
    await writeReports(outputDir, ["diff.json", "diff.md"])
    const outputs = await run(cwd, { OUTPUT_DIR: outputDir, FORMAT: "both" })
    expect(outputs["diff-md-path"]).toBe(join(outputDir, "diff.md"))
    expect(outputs["diff-json-path"]).toBe(join(outputDir, "diff.json"))
    expect(isAbsolute(outputs["diff-md-path"] ?? "")).toBe(true)
  })

  it("gives empty paths when the CLI stopped before writing, as a plugin error does", async () => {
    // A plugin that fails to load exits 3, the code a tripped gate exits with; the empty
    // `diff-md-path` is what keeps the comment step from running against no file.
    const cwd = await workingDirectory()
    await mkdir(join(cwd, "out"))
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: "both" })
    expect(outputs).toEqual({ "diff-json-path": "", "diff-md-path": "" })
  })

  it.each([
    ["json", { "diff-json-path": "diff.json", "diff-md-path": "" }],
    ["md", { "diff-json-path": "", "diff-md-path": "diff.md" }],
  ])("names only what --format %s asked for, whatever else is there", async (format, expected) => {
    const cwd = await workingDirectory()
    await writeReports(join(cwd, "out"), ["diff.json", "diff.md"])
    const outputs = await run(cwd, { OUTPUT_DIR: "out", FORMAT: format })
    expect(outputs).toEqual({
      "diff-json-path": expected["diff-json-path"] && join(cwd, "out", "diff.json"),
      "diff-md-path": expected["diff-md-path"] && join(cwd, "out", "diff.md"),
    })
  })
})
