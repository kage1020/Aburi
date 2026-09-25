import { existsSync } from "node:fs"
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
): Promise<{ code: number; stderr: string; wrote: string[] | null }> {
  const stderr = new MemStream()
  const out = resolve(scratch, "out")
  const code = await runCli({
    argv: ["scan", "--output-dir", out, ...flags],
    stdout: new MemStream(),
    stderr,
    env: {},
    cwd: scratch,
  })
  const wrote = existsSync(out) ? await readdir(out, { recursive: true }) : null
  return { code, stderr: stderr.text(), wrote: wrote === null ? null : wrote.sort() }
}

const IR = ["aburi.ir.json"]
// `components/*.md` is written with `workspace.md` and governed by the same format.
const MARKDOWN = ["components", "components/format-flags.md", "workspace.md"]
const BOTH = [...IR, ...MARKDOWN].sort()

describe("scan format flags", () => {
  it.each([
    [[], BOTH],
    [["--format", "both"], BOTH],
    [["--format", "json"], IR],
    [["--format", "md"], MARKDOWN],
    [["--no-md"], IR],
    [["--no-json"], MARKDOWN],
    [["--format", "json", "--no-md"], IR],
    [["--format", "md", "--no-json"], MARKDOWN],
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
    [
      ["--format", "both", "--no-json"],
      "--format both and --no-json contradict each other: drop one",
    ],
    [
      // Only the flag that contradicts is named; `--no-md` agrees with `--format json`.
      ["--format", "json", "--no-md", "--no-json"],
      "--format json and --no-json contradict each other: drop one",
    ],
    [
      ["--format", "both", "--no-md", "--no-json"],
      "--format both contradicts both --no-md and --no-json: drop --format both, or both of them",
    ],
  ])("%j is refused with exit 2 and creates no output directory", async (flags, message) => {
    const { code, stderr, wrote } = await scan(...flags)
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toBe(`${message}\n`)
    expect(wrote).toBeNull()
  })
})
