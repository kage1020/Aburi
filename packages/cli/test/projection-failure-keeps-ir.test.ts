import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runScan } from "../src"
import { writeTypeScriptWorkspace } from "./fixtures"

/**
 * The IR is what every page is derived from, so it is written before any of them. Written
 * last, it went down with the first Markdown page that threw: a component page too large to
 * assemble ended `aburi scan` with `workspace.md` on disk and no `aburi.ir.json`. A projection
 * that fails for real takes tens of thousands of Symbols, so the page is stood in for here.
 */

const FAILURE = "Maximum call stack size exceeded"

vi.mock("@aburi/markdown-projection", async (importOriginal) => {
  const projection = await importOriginal<typeof import("@aburi/markdown-projection")>()
  return {
    ...projection,
    projectComponent: () => {
      throw new RangeError(FAILURE)
    },
  }
})

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-projection-failure-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("a Markdown projection that throws", () => {
  it("still leaves the IR it was projecting from", async () => {
    await writeTypeScriptWorkspace(scratch, "projection-failure-fixture")

    await expect(runScan({ cwd: scratch })).rejects.toThrow(FAILURE)

    expect(await readdir(resolve(scratch, "out"))).toContain("aburi.ir.json")
    const ir = JSON.parse(await readFile(resolve(scratch, "out", "aburi.ir.json"), "utf8"))
    expect(ir.components.length).toBeGreaterThan(0)
  })
})
