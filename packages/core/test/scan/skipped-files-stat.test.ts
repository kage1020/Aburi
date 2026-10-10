import { spend, useScratchWorkspace } from "@aburi/test-support"
import type { Config, ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../../src"
import { oneSymbolPerFile, scanStubs } from "../fixtures/plugins"

const workspace = useScratchWorkspace("skipped-files")

/** Refuses `refused.stub`, throws on `boom.stub`, spends 250ms on `slow.stub`, parses the rest. */
const language = oneSymbolPerFile({
  parseFile: async (file) => {
    if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
    if (file.path === "slow.stub") spend(250)
    const errors: ParseError[] =
      file.path === "refused.stub"
        ? [{ message: "wrong dialect", line: 1, column: 1, recoverable: false }]
        : []
    return { tree: {}, errors, imports: [] }
  },
})

async function scanFiles(files: Record<string, string>, config: Config = {}) {
  for (const [name, content] of Object.entries(files)) await workspace.writeSource(name, content)
  return scanStubs(workspace.root, { config, languages: [language] })
}

describe("stats.skippedFiles — the Document names what the scan lost", () => {
  it("lists every reason in one array, discovery-time and extraction-time alike", async () => {
    const { ir } = await scanFiles(
      {
        "ok.stub": "ok",
        "big.stub": "x".repeat(2000),
        "boom.stub": "boom",
        "refused.stub": "refused",
      },
      { maxFileSizeBytes: 1024 },
    )
    expect(ir.stats.skippedFiles).toEqual([
      { path: "big.stub", reason: "over-size" },
      { path: "boom.stub", reason: "extraction-failed" },
      { path: "refused.stub", reason: "parse-failed" },
    ])
    expect(ir.stats.skippedFiles).toHaveLength(ir.stats.totalFiles - ir.stats.parsedFiles)
  })

  it("passes its own integrity check, sort order included", async () => {
    const big = "x".repeat(2000)
    const { ir } = await scanFiles(
      { "Z.stub": big, "a.stub": big, "\u00e9.stub": big, "b.stub": big },
      { maxFileSizeBytes: 1024 },
    )
    expect(ir.stats.skippedFiles).toHaveLength(4)
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("names a file no Symbol in it could have named, and keeps the rest of the workspace", async () => {
    const { ir } = await scanFiles({ "ok.stub": "ok", "od#d.stub": "odd" })

    expect(ir.stats.skippedFiles).toEqual([{ path: "od#d.stub", reason: "unroutable" }])
    expect([ir.stats.totalFiles, ir.stats.parsedFiles]).toEqual([2, 1])
    expect(ir.symbols).toHaveLength(1)
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("omits the key entirely when nothing was lost", async () => {
    const { ir } = await scanFiles({ "ok.stub": "ok" })
    expect(ir.stats).not.toHaveProperty("skippedFiles")
  })

  it("says how long a timed-out file ran and what it was given, outside the Document", async () => {
    const result = await scanFiles({ "slow.stub": "slow" }, { parseTimeoutMs: 100 })

    const spent = /^extraction reached (\d+)ms, exceeding parseTimeoutMs \(100ms\)$/.exec(
      result.skipped[0]?.detail ?? "",
    )
    expect(result.skipped[0]?.reason).toBe("parse-timeout")
    expect(Number(spent?.[1])).toBeGreaterThanOrEqual(250)
    expect(result.ir.stats.skippedFiles).toEqual([{ path: "slow.stub", reason: "parse-timeout" }])
  })

  it("carries no detail, so the bytes do not depend on where the repository sits", async () => {
    const result = await scanFiles({ "refused.stub": "refused" })

    expect(result.skipped[0]?.detail).toContain("wrong dialect")
    expect(result.ir.stats.skippedFiles).toStrictEqual([
      { path: "refused.stub", reason: "parse-failed" },
    ])
  })
})
