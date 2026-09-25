import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli } from "../src"
import { MemStream, writeTypeScriptWorkspace } from "./fixtures"

/** `scan`'s `--format`, `--no-md` and `--no-json`: one output taken away, never a guess. */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-format-flags-"))
  await writeTypeScriptWorkspace(scratch, "format-flags")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scan(
  ...flags: string[]
): Promise<{ code: number; stderr: string; wrote: string[] }> {
  const stderr = new MemStream()
  const out = resolve(scratch, "out")
  const code = await runCli({
    argv: ["scan", "--output-dir", out, ...flags],
    stdout: new MemStream(),
    stderr,
    env: {},
    cwd: scratch,
  })
  const wrote = await readdir(out).catch(() => [])
  return {
    code,
    stderr: stderr.text(),
    wrote: wrote.filter((f) => f.startsWith("aburi.ir") || f === "workspace.md").sort(),
  }
}

describe("scan format flags", () => {
  it.each([
    [["--no-md"], ["aburi.ir.json"]],
    [["--no-json"], ["workspace.md"]],
    [["--format", "json", "--no-md"], ["aburi.ir.json"]],
    [["--format", "md", "--no-json"], ["workspace.md"]],
  ])("%j writes %j", async (flags, expected) => {
    const { code, wrote } = await scan(...flags)
    expect(code).toBe(EXIT.SUCCESS)
    expect(wrote).toEqual(expected)
  })

  it.each([
    [["--no-md", "--no-json"], "--no-md and --no-json leave scan nothing to write"],
    [["--format", "md", "--no-md"], "--format md and --no-md contradict each other: drop one"],
    [
      ["--format", "json", "--no-json"],
      "--format json and --no-json contradict each other: drop one",
    ],
    [["--format", "both", "--no-md"], "--format both and --no-md contradict each other: drop one"],
  ])("%j is refused with exit 2 and writes nothing", async (flags, message) => {
    const { code, stderr, wrote } = await scan(...flags)
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toBe(`${message}\n`)
    expect(wrote).toEqual([])
  })
})
