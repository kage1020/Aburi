import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { makeLanguageId } from "@aburi/core"
import type { DiffResult, IR, SkippedFile } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runDiff } from "../src"
import { symbolId } from "./fixtures"

/**
 * `--fail-on removed` must not trip on a file the head scan never read.
 *
 * That gate is the reason the whole chain matters: a scan that withdrew one file used to
 * produce a document indistinguishable from one where the author deleted its API, and the
 * gate fired with a confident count and the wrong explanation.
 */

let scratch = ""

function makeIR(symbols: IR["symbols"], skipped?: readonly SkippedFile[], discovered = 2): IR {
  const totalFiles = discovered
  return {
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols,
    dependencies: [],
    stats: {
      totalFiles,
      parsedFiles: totalFiles - (skipped?.length ?? 0),
      keptSymbols: symbols.length,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
      ...(skipped === undefined ? {} : { skippedFiles: [...skipped] }),
    },
  }
}

function symbol(file: string, name: string): IR["symbols"][number] {
  return {
    id: symbolId(`ts:${file}#${name}`),
    kind: "function",
    extKind: null,
    name,
    language: makeLanguageId("ts"),
    component: null,
    visibility: "public",
    decorators: [],
    signature: null,
    rules: [],
    effects: [],
    calls: [],
    source: { file, startLine: 1, endLine: 10, startColumn: null, endColumn: null },
    fingerprint: { api: "aaa000000000", logic: "bbb000000000", syntax: "ccc000000000" },
    confidence: "high",
    derivedBy: [],
    dropped: false,
    dropReason: null,
  }
}

async function writePair(baseIR: IR, headIR: IR) {
  const basePath = resolve(scratch, "base.json")
  const headPath = resolve(scratch, "head.json")
  await writeFile(basePath, JSON.stringify(baseIR), "utf8")
  await writeFile(headPath, JSON.stringify(headIR), "utf8")
  return { basePath, headPath }
}

const gone = symbol("src/gone.ts", "handleRequest")
const kept = symbol("src/kept.ts", "kept")

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-unknown-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("aburi diff — a file the head scan never read", () => {
  it("does not trip --fail-on removed", async () => {
    const { basePath, headPath } = await writePair(
      makeIR([gone, kept]),
      makeIR([kept], [{ path: "src/gone.ts", reason: "parse-failed" }]),
    )
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      failOn: "removed",
      warn: () => {},
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.triggered).toBeNull()
  })

  it("does trip --fail-on unknown, and respects a threshold", async () => {
    // `alsoGone` sorts before `handleRequest`, and the reader holds the document to
    // invariant #11.
    const other = symbol("src/gone.ts", "alsoGone")
    const { basePath, headPath } = await writePair(
      makeIR([other, gone, kept]),
      makeIR([kept], [{ path: "src/gone.ts", reason: "parse-failed" }]),
    )
    const gated = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      failOn: "unknown",
      warn: () => {},
    })
    expect(gated.exitCode).toBe(EXIT.GATE)
    expect(gated.triggered?.observed).toBe(2)

    const under = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      failOn: "unknown:>2",
      warn: () => {},
    })
    expect(under.exitCode).toBe(EXIT.SUCCESS)
  })

  it("names it in diff.md as unknown rather than removed", async () => {
    const { basePath, headPath } = await writePair(
      makeIR([gone, kept]),
      makeIR([kept], [{ path: "src/gone.ts", reason: "parse-timeout" }]),
    )
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: () => {},
    })
    if (report.diffMdPath === null) throw new Error("expected diffMdPath")
    const md = await readFile(report.diffMdPath, "utf8")
    expect(md).toContain("## ❔ Unknown")
    expect(md).toContain("the head scan skipped `src/gone.ts` (parse-timeout)")
    expect(md).not.toContain("## ➖ Removed")
  })

  it("warns when a document lost files it cannot enumerate", async () => {
    // An IR written before `stats.skippedFiles` existed reports the count and no list, so
    // the diff cannot tell a loss from a deletion. It reports what it can see; the CLI says
    // what it could not check.
    const headWithoutList: IR = {
      ...makeIR([kept]),
      stats: { ...makeIR([kept]).stats, totalFiles: 2, parsedFiles: 1 },
    }
    const { basePath, headPath } = await writePair(makeIR([gone, kept]), headWithoutList)
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      failOn: "removed",
      warn: (m) => warnings.push(m),
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain(
      "head IR reports 1 file(s) it did not parse but has no stats.skippedFiles",
    )
    expect(warnings.join("\n")).toContain("reported as removed")
  })

  it("warns about the base side too, where the phantom is an addition", async () => {
    const baseWithoutList: IR = {
      ...makeIR([kept]),
      stats: { ...makeIR([kept]).stats, totalFiles: 2, parsedFiles: 1 },
    }
    const { basePath, headPath } = await writePair(baseWithoutList, makeIR([gone, kept]))
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("base IR reports 1 file(s) it did not parse")
    expect(warnings.join("\n")).toContain("reported as added")
  })

  it("puts the count on the stdout summary line, where every CI job sees it", async () => {
    // The stderr warning cannot fire here — `stats.skippedFiles` is present on both sides —
    // so without this the whole incident is invisible to anyone who did not pass
    // `--fail-on unknown`. It qualifies the counts beside it: they are that much short.
    const { basePath, headPath } = await writePair(
      makeIR([gone, kept]),
      makeIR([kept], [{ path: "src/gone.ts", reason: "parse-failed" }]),
    )
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: () => {},
    })
    expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0 · ?1 unknown")
  })

  it("leaves the summary line alone when nothing is unknown", async () => {
    const { basePath, headPath } = await writePair(makeIR([gone, kept]), makeIR([kept]))
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: () => {},
    })
    expect(report.summaryLine).toBe("+0 -1 ~0 ↔0 ⤴0")
  })

  it("names the files both scans skipped, which no unknown entry can cover", async () => {
    // Neither document holds Symbols from a file both sides dropped, so there is no leftover
    // to classify and the diff is silent about a file it never compared.
    const both = { path: "vendor/huge.ts", reason: "over-size" } as const
    const { basePath, headPath } = await writePair(makeIR([kept], [both]), makeIR([kept], [both]))
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    expect(report.summaryLine).toBe("+0 -0 ~0 ↔0 ⤴0")
    // Not "are not represented in this diff" — they are, now, and the line points at where.
    expect(warnings.join("\n")).toContain(
      "1 file(s) were skipped by both scans; see notCompared[] in diff.json: vendor/huge.ts",
    )
    // stderr is the cover note; the artifact is what a bot or a pasted PR comment gets, and
    // it used to carry no trace of the file at all.
    const written = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
    expect(written.notCompared).toEqual([
      { path: "vendor/huge.ts", baseReason: "over-size", headReason: "over-size" },
    ])
    const md = await readFile(report.diffMdPath ?? "", "utf8")
    expect(md).toContain("## 🚫 Not compared")
    expect(md).toContain("`vendor/huge.ts` — over-size on both")
  })

  it("summarises the tail rather than printing a workspace's whole blind spot", async () => {
    // The reason the line is shorter than the artifact. Eleven files: ten named, the rest
    // counted, and `diff.json` carries all of them with their reasons.
    const lost = Array.from({ length: 11 }, (_, i) => ({
      path: `vendor/gen${String(i).padStart(2, "0")}.js`,
      reason: "over-size" as const,
    }))
    const { basePath, headPath } = await writePair(
      makeIR([kept], lost, 12),
      makeIR([kept], lost, 12),
    )
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    const line = warnings.join("\n")
    expect(line).toContain("11 file(s) were skipped by both scans")
    expect(line).toContain("vendor/gen09.js, and 1 more.")
    expect(line).not.toContain("vendor/gen10.js")
    const written = JSON.parse(await readFile(report.diffJsonPath ?? "", "utf8")) as DiffResult
    expect(written.notCompared).toHaveLength(11)
  })

  it("says nothing about symmetric loss when only one side lost the file", async () => {
    const { basePath, headPath } = await writePair(
      makeIR([gone, kept]),
      makeIR([kept], [{ path: "src/gone.ts", reason: "parse-failed" }]),
    )
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).not.toContain("skipped by both scans")
  })

  it("says nothing when both documents parsed everything they discovered", async () => {
    const { basePath, headPath } = await writePair(makeIR([gone, kept]), makeIR([gone, kept]))
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).not.toContain("stats.skippedFiles")
  })
})
