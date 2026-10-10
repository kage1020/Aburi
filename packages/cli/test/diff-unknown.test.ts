import { readFile } from "node:fs/promises"
import { useScratchWorkspace } from "@aburi/test-support"
import type { DiffResult, SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import { diffDocuments, documentWith, symbolFor } from "./ir-documents"

const workspace = useScratchWorkspace("diff-unknown")

const GONE = symbolFor("ts:src/gone.ts#handleRequest")
const ALSO_GONE = symbolFor("ts:src/gone.ts#alsoGone")
const KEPT = symbolFor("ts:src/kept.ts#kept")
const GONE_FAILED: SkippedFile = { path: "src/gone.ts", reason: "parse-failed" }

const BOTH = documentWith({ symbols: [GONE, KEPT] })
const HEAD_LOST_GONE = documentWith({ symbols: [KEPT], skipped: [GONE_FAILED] })

async function readJson(path: string | null): Promise<DiffResult> {
  return JSON.parse(await readFile(path ?? "", "utf8")) as DiffResult
}

describe("aburi diff — a file the head scan never read", () => {
  it("does not trip --fail-on removed", async () => {
    const { report } = await diffDocuments(workspace.root, BOTH, HEAD_LOST_GONE, {
      failOn: "removed",
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.triggered).toBeNull()
  })

  it.each([
    ["unknown", { clause: { token: "unknown", threshold: null }, observed: 2 }],
    ["unknown:>2", null],
  ])("counts its Symbols under --fail-on %s", async (failOn, triggered) => {
    const { report } = await diffDocuments(
      workspace.root,
      documentWith({ symbols: [ALSO_GONE, GONE, KEPT] }),
      HEAD_LOST_GONE,
      { failOn },
    )
    expect(report.triggered).toEqual(triggered)
    expect(report.exitCode).toBe(triggered === null ? EXIT.SUCCESS : EXIT.GATE)
  })

  it("names it in diff.md as unknown rather than removed", async () => {
    const { report } = await diffDocuments(
      workspace.root,
      BOTH,
      documentWith({
        symbols: [KEPT],
        skipped: [{ path: "src/gone.ts", reason: "parse-timeout" }],
      }),
    )
    const md = await readFile(report.diffMdPath ?? "", "utf8")
    expect(md).toContain("## ❔ Unknown")
    expect(md).toContain("the head scan skipped `src/gone.ts` (parse-timeout)")
    expect(md).not.toContain("## ➖ Removed")
  })

  it.each([
    ["+0 -0 ~0 ↔0 ⤴0 · ?1 unknown", HEAD_LOST_GONE],
    ["+0 -1 ~0 ↔0 ⤴0", documentWith({ symbols: [KEPT] })],
  ])("puts %j on the stdout summary line", async (summaryLine, head) => {
    const { report } = await diffDocuments(workspace.root, BOTH, head)
    expect(report.summaryLine).toBe(summaryLine)
  })
})

describe("aburi diff — a document that lost files it cannot name", () => {
  const COUNTED_LOSS = documentWith({ symbols: [KEPT], unnamedLosses: 1 })

  it("warns about the head, whose loss reads as removals", async () => {
    const { report, said } = await diffDocuments(workspace.root, BOTH, COUNTED_LOSS, {
      failOn: "removed",
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain(
      "head IR reports 1 file(s) it did not parse but has no stats.skippedFiles",
    )
    expect(said).toContain("reported as removed")
  })

  it("warns about the base, whose loss reads as additions", async () => {
    const { said } = await diffDocuments(workspace.root, COUNTED_LOSS, BOTH)
    expect(said).toContain("base IR reports 1 file(s) it did not parse")
    expect(said).toContain("reported as added")
  })

  it("says nothing when both documents parsed everything they discovered", async () => {
    const { said } = await diffDocuments(workspace.root, BOTH, BOTH)
    expect(said).not.toContain("stats.skippedFiles")
  })
})

describe("aburi diff — a file both scans skipped", () => {
  it("names it in the warning, diff.json and diff.md, since no unknown entry can", async () => {
    const both: SkippedFile = { path: "vendor/huge.ts", reason: "over-size" }
    const lostBoth = documentWith({ symbols: [KEPT], skipped: [both] })

    const { report, said } = await diffDocuments(workspace.root, lostBoth, lostBoth)

    expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    expect(said).toContain(
      "1 file(s) were skipped by both scans; see notCompared[] in diff.json: vendor/huge.ts",
    )
    expect((await readJson(report.diffJsonPath)).notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" },
    ])
    const md = await readFile(report.diffMdPath ?? "", "utf8")
    expect(md).toContain("## 🚫 Not compared")
    expect(md).toContain("`vendor/huge.ts` — over-size on both")
  })

  it("summarises the tail rather than printing a workspace's whole blind spot", async () => {
    const lost = Array.from({ length: 11 }, (_, i) => ({
      path: `vendor/gen${String(i).padStart(2, "0")}.js`,
      reason: "over-size" as const,
    }))
    const lostBoth = documentWith({ symbols: [KEPT], skipped: lost })

    const { report, said } = await diffDocuments(workspace.root, lostBoth, lostBoth)

    expect(said).toContain("11 file(s) were skipped by both scans")
    expect(said).toContain("vendor/gen09.js, and 1 more.")
    expect(said).not.toContain("vendor/gen10.js")
    expect((await readJson(report.diffJsonPath)).notCompared).toHaveLength(11)
  })

  it("says nothing about it when only one side lost the file", async () => {
    const { said } = await diffDocuments(workspace.root, BOTH, HEAD_LOST_GONE)
    expect(said).not.toContain("skipped by both scans")
  })
})
