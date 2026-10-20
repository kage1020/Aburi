import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { filesUnder, writeEarlierReports, writeTypeScriptWorkspace } from "./workspace"

const workspace = useScratchWorkspace("option-repeats")

const repeated = (option: string, first: string, then: string) =>
  `${option} is given more than once ("${first}", then "${then}"): pass one`

describe("an option that takes one value, given twice", () => {
  it.each([
    [
      ["init", "--output", "a.json", "--output", "b.json"],
      repeated("--output", "a.json", "b.json"),
    ],
    [["scan", "--output-dir", "a", "--output-dir", "b"], repeated("--output-dir", "a", "b")],
    [["scan", "--format", "json", "--format", "md"], repeated("--format", "json", "md")],
    [["scan", "--format", "json", "--format", "bogus"], repeated("--format", "json", "bogus")],
    [
      ["scan", "--format", "bogus", "--format", "json"],
      "error: option '--format <format>' argument 'bogus' is invalid. --format must be one of: json | md | both",
    ],
    [
      ["scan", "--config", "a.json", "--config", "b.json"],
      repeated("--config", "a.json", "b.json"),
    ],
    [
      ["diff", "--base", "a.json", "--base", "b.json", "--head", "c.json"],
      repeated("--base", "a.json", "b.json"),
    ],
    [
      ["diff", "--base", "a.json", "--head", "b.json", "--head", "c.json"],
      repeated("--head", "b.json", "c.json"),
    ],
    [
      ["diff", "main..HEAD", "--output-dir", "a", "--output-dir", "b"],
      repeated("--output-dir", "a", "b"),
    ],
    [
      ["diff", "main..HEAD", "--format", "both", "--format", "md"],
      repeated("--format", "both", "md"),
    ],
    [
      ["diff", "main..HEAD", "--max-bytes", "1000", "--max-bytes", "2000"],
      repeated("--max-bytes", "1000", "2000"),
    ],
    [
      ["diff", "main..HEAD", "--max-bytes", "1000", "--max-bytes", "0"],
      repeated("--max-bytes", "1000", "0"),
    ],
    [
      ["diff", "main..HEAD", "--config", "a.json", "--config", "b.json"],
      repeated("--config", "a.json", "b.json"),
    ],
    [
      ["explain", "alpha", "--ir", "a.json", "--ir", "b.json"],
      repeated("--ir", "a.json", "b.json"),
    ],
    [
      ["explain", "alpha", "--output", "a.md", "--output", "b.md"],
      repeated("--output", "a.md", "b.md"),
    ],
    [
      ["explain", "alpha", "--config=a.json", "--config", "a.json"],
      repeated("--config", "a.json", "a.json"),
    ],
    [
      ["--log-level", "debug", "--log-level", "info", "scan"],
      repeated("--log-level", "debug", "info"),
    ],
    [
      ["--log-level", "debug", "scan", "--log-level", "info"],
      repeated("--log-level", "debug", "info"),
    ],
    [
      ["diff", "main..HEAD", "--log-level", "warn", "--log-level", "loud"],
      repeated("--log-level", "warn", "loud"),
    ],
  ])("%j exits 2 naming the option, and writes or removes nothing", async (argv, message) => {
    const earlier = await writeEarlierReports(workspace.root, [".", "out", "a", "b"])
    const { code, stdout, stderr } = await runCliIn(workspace.root, argv)
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toBe(`${message}\n`)
    expect(stdout).toBe("")
    expect(await filesUnder(workspace.root)).toEqual(earlier)
  })
})

describe("a flag, repeated", () => {
  it.each([
    [["--compact", "--compact"]],
    [["--no-timestamp", "--no-timestamp"]],
  ])("scan %j runs", async (flags) => {
    await writeTypeScriptWorkspace(workspace.root, "option-repeats")
    const { code, stderr } = await runCliIn(workspace.root, ["scan", ...flags])
    expect(stderr).toBe("")
    expect(code).toBe(EXIT.SUCCESS)
  })
})
