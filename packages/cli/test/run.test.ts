import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { runCliIn } from "./run-cli"

const workspace = useScratchWorkspace("run")

const run = (...argv: string[]) => runCliIn(workspace.root, argv)

describe("aburi — the exit codes", () => {
  it("keeps the number of each exit class stable", () => {
    expect(EXIT).toEqual({ SUCCESS: 0, RUNTIME: 1, INPUT_ERROR: 2, GATE: 3 })
  })

  it("prints the version and exits 0", async () => {
    const { code, stdout } = await run("--version")
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("prints the usage and exits 0", async () => {
    const { code, stdout } = await run("--help")
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout).toContain("Usage")
  })

  it("refuses a command it does not have at exit 2", async () => {
    expect((await run("nope")).code).toBe(EXIT.INPUT_ERROR)
  })
})

describe("aburi diff — the arguments it needs", () => {
  it.each([
    [
      "neither a ref spec nor --base/--head",
      [],
      "aburi diff needs either <base>..<head> or --base <ir.json> --head <ir.json>.",
    ],
    [
      "--base without --head",
      ["--base", "./b.json"],
      "--base was supplied without a matching --head <ir.json>.",
    ],
    [
      "--base beside a ref spec",
      ["main..HEAD", "--base", "./b.json"],
      "--base cannot be combined with a ref spec argument.",
    ],
  ])("refuses %s at exit 2", async (_, flags, says) => {
    const { code, stderr } = await run("diff", ...flags)
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain(says)
  })
})
