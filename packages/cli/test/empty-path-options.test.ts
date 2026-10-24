import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"
import { filesUnder, writeEarlierReports } from "./workspace"

const workspace = useScratchWorkspace("empty-path-options")

const empty = (option: string) =>
  `error: option '${option} <path>' argument '' is invalid. a path must not be empty`

describe("an option that takes a path, given an empty value", () => {
  it.each([
    [["init", "--output", ""], empty("--output")],
    [["scan", "--output-dir", ""], empty("--output-dir")],
    [["scan", "--output-dir="], empty("--output-dir")],
    [["scan", "--config", ""], empty("--config")],
    [["diff", "--base", "", "--head", "b.json"], empty("--base")],
    [["diff", "main..HEAD", "--head", ""], empty("--head")],
    [["diff", "main..HEAD", "--output-dir", ""], empty("--output-dir")],
    [["diff", "main..HEAD", "--config", ""], empty("--config")],
    [["explain", "alpha", "--ir", ""], empty("--ir")],
    [["explain", "alpha", "--output", ""], empty("--output")],
    [["explain", "alpha", "--config", ""], empty("--config")],
  ])("%j exits 2 naming the option, and writes or removes nothing", async (argv, message) => {
    const earlier = await writeEarlierReports(workspace.root, [".", "out"])
    const { code, stdout, stderr } = await runCliIn(workspace.root, argv)
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toBe(`${message}\n`)
    expect(stdout).toBe("")
    expect(await filesUnder(workspace.root)).toEqual(earlier)
  })
})
