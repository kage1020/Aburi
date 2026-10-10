import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { writeTypeScriptWorkspace } from "./workspace"

const workspace = useScratchWorkspace("format-flags")

beforeEach(async () => {
  await writeTypeScriptWorkspace(workspace.root, "format-flags")
})

async function scan(
  ...flags: string[]
): Promise<{ code: number; stderr: string; wrote: string[] | null }> {
  const out = resolve(workspace.root, "out")
  const { code, stderr } = await runCliIn(workspace.root, ["scan", "--output-dir", out, ...flags])
  if (!existsSync(out)) return { code, stderr, wrote: null }
  const wrote = (await readdir(out, { recursive: true })).map((entry) => entry.replaceAll(sep, "/"))
  return { code, stderr, wrote: wrote.sort() }
}

const IR = ["aburi.ir.json"]
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
