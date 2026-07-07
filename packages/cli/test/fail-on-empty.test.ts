import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import { EXIT, FailOnParseError, parseFailOn, runCli } from "../src"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

describe("parseFailOn — empty-value rejection", () => {
  it("throws FailOnParseError on empty string (fail-open guard)", () => {
    expect(() => parseFailOn("")).toThrow(FailOnParseError)
  })

  it("throws on comma-only value", () => {
    expect(() => parseFailOn(",,")).toThrow(FailOnParseError)
  })

  it("still tolerates internal trailing commas when at least one clause survives", () => {
    expect(parseFailOn("changed,,")).toEqual([{ token: "changed", threshold: null }])
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
