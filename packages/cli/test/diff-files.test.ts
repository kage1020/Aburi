import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { call, makeSymbol, useScratchWorkspace } from "@aburi/test-support"
import type { CallResolutionStats, IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DIFF_JSON_FILENAME, DIFF_MD_FILENAME, EXIT, runDiff } from "../src"
import { pathExists } from "../src/fs-probe"
import { diffDocuments, documentWith } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { writeIRs } from "./workspace"

const workspace = useScratchWorkspace("diff-files")

const EMPTY = documentWith({ symbols: [] })
const FOO = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
const ADDED_FOO = documentWith({ symbols: [FOO] })

function headWithCensus(callResolution: CallResolutionStats): IR {
  const unresolved = callResolution.totalCalls - callResolution.resolvedCalls
  const calls = Array.from({ length: unresolved }, (_, i) =>
    call({ target: `mystery${i}`, line: i + 2 }),
  )
  const head = documentWith({ symbols: [{ ...FOO, calls }] })
  return { ...head, stats: { ...head.stats, callResolution } }
}

describe("aburi diff --base/--head", () => {
  it("diffs two IR files and writes diff.json and diff.md", async () => {
    const { report } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO)

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(report.diffJsonPath).toBe(resolve(workspace.root, "out", DIFF_JSON_FILENAME))
    expect(report.diffMdPath).toBe(resolve(workspace.root, "out", DIFF_MD_FILENAME))
    expect(await readFile(report.diffJsonPath ?? "", "utf8")).toMatch(/"added"\s*:\s*1/)
    expect(await readFile(report.diffMdPath ?? "", "utf8")).toContain("Added")
  })

  it("trips --fail-on and exits 3", async () => {
    const { report } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO, { failOn: "added" })

    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.triggered).toEqual({ clause: { token: "added", threshold: null }, observed: 1 })
  })

  it("names the tripped clause on stderr from the command line", async () => {
    const { base, head } = await writeIRs(workspace.root, EMPTY, ADDED_FOO)

    const { code, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      base,
      "--head",
      head,
      "--fail-on",
      "added",
    ])

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain("--fail-on added tripped (observed: 1 added)")
  })

  it("leaves no earlier report behind when the run stops before it writes one", async () => {
    const { paths, report } = await diffDocuments(workspace.root, EMPTY, EMPTY)
    expect(await pathExists(report.diffMdPath ?? "")).toBe(true)

    const missing = resolve(workspace.root, "missing.json")
    await expect(runDiff({ cwd: workspace.root, base: paths.base, head: missing })).rejects.toThrow(
      `Failed to read IR file "${missing}"`,
    )
    expect(await pathExists(resolve(workspace.root, "out", DIFF_MD_FILENAME))).toBe(false)
    expect(await pathExists(resolve(workspace.root, "out", DIFF_JSON_FILENAME))).toBe(false)
  })
})

describe("aburi diff — the head's call-resolution census", () => {
  it.each([
    [
      {
        totalCalls: 3,
        resolvedCalls: 0,
        unresolved: { localScope: 0, external: 1, dynamic: 2, ambiguous: 0, noMatch: 0 },
      },
      "calls 3 · resolved 0 · unresolved 3 (external 1 · dynamic 2)",
    ],
    [
      {
        totalCalls: 0,
        resolvedCalls: 0,
        unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
      },
      "calls 0 · resolved 0 · unresolved 0",
    ],
  ])("renders %j", async (census, line) => {
    const { report } = await diffDocuments(workspace.root, EMPTY, headWithCensus(census))
    expect(report.callResolutionLine).toBe(line)
  })

  it("prints the line right after the summary", async () => {
    const head = headWithCensus({
      totalCalls: 1,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 1, noMatch: 0 },
    })
    const paths = await writeIRs(workspace.root, EMPTY, head)

    const { stdout } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
    ])

    expect(stdout.split("\n").slice(0, 2)).toEqual([
      "+1 -0 ~0 ↔0 ⤴0",
      "calls 1 · resolved 0 · unresolved 1 (ambiguous 1)",
    ])
  })

  it("is unavailable for a head IR written before the census existed, and says why on stderr", async () => {
    const { report, said } = await diffDocuments(workspace.root, EMPTY, ADDED_FOO)
    expect(report.callResolutionLine).toBeNull()
    expect(said).toContain("head IR has no stats.callResolution")
  })

  it("prints nothing but the summary when the census is unavailable", async () => {
    const paths = await writeIRs(workspace.root, EMPTY, ADDED_FOO)

    const { stdout, stderr } = await runCliIn(workspace.root, [
      "diff",
      "--base",
      paths.base,
      "--head",
      paths.head,
      "--format",
      "json",
    ])

    expect(stdout).toBe("+1 -0 ~0 ↔0 ⤴0\n")
    expect(stderr).toContain("no stats.callResolution")
  })
})
