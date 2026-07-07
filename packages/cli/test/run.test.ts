import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import { EXIT, runCli } from "../src"

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
