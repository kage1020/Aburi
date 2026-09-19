import { describe, expect, it } from "vitest"
import { EXIT, runCli } from "../src"
import { MemStream } from "./fixtures"

function makeStreams(): { stdout: MemStream; stderr: MemStream } {
  return { stdout: new MemStream(), stderr: new MemStream() }
}

/** CL1 — `aburi --version` prints a single line, exit 0. */
describe("CL1 — --version", () => {
  it("prints a version string and returns EXIT.SUCCESS", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({ argv: ["--version"], stdout, stderr, env: {} })
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.text().trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

/** CL2 — `aburi --help` returns exit 0. */
describe("CL2 — --help", () => {
  it("returns EXIT.SUCCESS and prints usage text", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({ argv: ["--help"], stdout, stderr, env: {} })
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.text()).toContain("Usage")
  })
})

/** CL3 — unknown command returns EXIT.INPUT_ERROR (2). */
describe("CL3 — unknown command", () => {
  it("returns EXIT.INPUT_ERROR", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({ argv: ["nope"], stdout, stderr, env: {} })
    expect(code).toBe(EXIT.INPUT_ERROR)
  })
})

/** CL10 — `aburi diff` with no arguments returns EXIT.INPUT_ERROR. */
describe("CL10 — diff arguments missing", () => {
  it("errors when neither refspec nor --base/--head is given", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({ argv: ["diff"], stdout, stderr, env: {} })
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr.text()).toContain("aburi diff needs")
  })

  it("errors when --base is set without --head", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({
      argv: ["diff", "--base", "./b.json"],
      stdout,
      stderr,
      env: {},
    })
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr.text()).toContain("--head")
  })
})

/** `cli-spec.md` — `--max-bytes` is read at argv parsing, so a typo never reaches a scan. */
describe("diff --max-bytes", () => {
  it("rejects a value that is not a plain byte count", async () => {
    // The last one reaches the `Number.isSafeInteger` check past the regex, which is the only
    // thing keeping that branch — and its own message — from reading as redundant and being
    // deleted. An overflowing count is not "not a positive integer"; it is too large to be one.
    for (const value of ["64kb", "0", "-1", "1.5", "", "99999999999999999999"]) {
      const { stdout, stderr } = makeStreams()
      const code = await runCli({
        argv: ["diff", "--base", "./b.json", "--head", "./h.json", "--max-bytes", value],
        stdout,
        stderr,
        env: {},
      })
      expect(code, `accepted --max-bytes ${JSON.stringify(value)}`).toBe(EXIT.INPUT_ERROR)
      expect(stderr.text()).toContain("--max-bytes")
      if (value === "99999999999999999999") {
        expect(stderr.text()).toContain("too large to be a byte count")
      }
    }
  })

  it("advertises the flag in `diff --help`, which the action probes for", async () => {
    const { stdout, stderr } = makeStreams()
    const code = await runCli({ argv: ["diff", "--help"], stdout, stderr, env: {} })
    expect(code).toBe(EXIT.SUCCESS)
    expect(stdout.text()).toContain("--max-bytes")
  })
})
