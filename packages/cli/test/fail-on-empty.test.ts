import { describe, expect, it } from "vitest"
import { EXIT, FailOnParseError, parseFailOn, runCli } from "../src"
import { MemStream } from "./fixtures"

describe("parseFailOn — empty-value rejection (fail-open guard)", () => {
  it.each([
    ["an empty string", ""],
    ["a comma-only value", ",,"],
  ])("throws FailOnParseError on %s", (_, spec) => {
    expect(() => parseFailOn(spec)).toThrow(FailOnParseError)
  })
})

describe("FailOnParseError → EXIT.INPUT_ERROR (not RUNTIME)", () => {
  it("maps to exit 2 through runCli", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["diff", "--base", "./missing.json", "--head", "./also.json", "--fail-on", ""],
      stdout,
      stderr,
      env: {},
      cwd: process.cwd(),
    })
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr.text()).toMatch(/empty --fail-on value|--fail-on value/)
  })
})
