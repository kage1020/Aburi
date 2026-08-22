import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { makeLanguageId, type SkippedFile } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  EXIT,
  formatFailOnMessage,
  reportScanIncidents,
  runCli,
  runDiff,
  runExplain,
  runScan,
  type ScanReport,
} from "../src"
import { gitWith, populate } from "./stub-language"

/**
 * Every command that scans reports what the scan lost.
 *
 * `aburi explain` and `aburi diff` run a full scan of their own and used to discard the
 * report: no incident line, and no exit code either, so a plugin exception that withdrew a
 * file left `explain` answering "No matches" at exit 1 and `diff` answering `+0 -0 ~0` at
 * exit 0. The scan is where the incident happens, so the scan is where it is now reported.
 *
 * The fixture writes its own language plugin into the workspace and names it by relative
 * path — a ref form the loader supports, and the only way to produce a refusal or an
 * extraction throw on demand, since no in-tree plugin will do either to order.
 */

/**
 * What the stub plugin refuses `bad.stub` with, as the reporter renders it. The scan
 * composes it from the `ParseError` the plugin returned, so it is a fact about the fixture
 * rather than about the CLI — and it is now on the command's stderr, where before the only
 * copy went through the run's `Logger`.
 */
const REFUSAL = "parse reported a non-recoverable error at 12:4 — unterminated string"

/**
 * The advice each reason's group line carries. Spelled once here rather than inline in four
 * assertions: an exact-byte test that repeats the sentence it is checking drifts one copy at
 * a time, and the subject of these tests is the shape of the report, not the wording.
 */
const PARSE_FAILED_ADVICE =
  "the language plugin refused the source. Deterministic: fix the file, or the plugin."
const EXTRACTION_FAILED_ADVICE =
  "a plugin threw while extracting. This is the reason the run does not exit clean."

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

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-incidents-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — the report goes to the caller's sink", () => {
  it("returns the report and emits no incident line when no sink was given", async () => {
    // Not the same as silence, and the option's docblock says so: the run's `Logger` is a
    // separate channel that still writes per-file lines to the real `process.stderr`. What is
    // asserted here is that the per-run report is the caller's to ask for.
    await populate(scratch, ["bad.stub", "boom.stub", "ok.stub"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.skipped).toHaveLength(2)
  })

  it("cannot let a broken sink change the exit code", async () => {
    // `aburi scan 2>&1 | head -1` reaches this: the pipe closes, the write throws, and the
    // report — already complete, with the IR already on disk — would come back as a runtime
    // error instead of the gate it is.
    await populate(scratch, ["boom.stub", "ok.stub"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: {
        warn: () => {
          throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
        },
      },
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.extractionFailures).toHaveLength(1)
  })

  it("emits the same lines the scan command printed, in the same order", async () => {
    await populate(scratch, ["bad.stub", "boom.stub", "warn.stub", "ok.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => lines.push(m) },
    })
    expect(lines).toEqual([
      "⚠ 1 file(s) had recoverable parse errors.",
      "⚠ 1 file(s) could not be parsed and were left out of the IR.",
      "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1",
      `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}`,
      `    bad.stub: ${REFUSAL}`,
      `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      "    boom.stub: plugin exploded",
    ])
  })

  it("labels every line it owns, and leaves the per-file listing unlabelled", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => lines.push(m), label: 'base ref "main"' },
    })
    expect(lines).toEqual([
      '⚠ base ref "main": 1 file(s) contributed no Symbols: extraction-failed=1',
      `⚠ base ref "main": extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      "    boom.stub: plugin exploded",
    ])
  })

  // Exact bytes, where `parse-failure-scan.test.ts` asserts two of these lines by substring.
  // The subjects differ: that test pins the split between recoverable and refused, this one
  // pins that the command's own stream carries the whole report and nothing else.
  //
  // "Everything on the injected stream", not "everything on stderr" — the run's `Logger` writes
  // its per-file lines to the real `process.stderr` and lands outside this capture. That gap is
  // why the CLI lists the files itself: at `ABURI_LOG_LEVEL=error` the report is all there is,
  // and for a discovery-time skip there is no `Logger` line to lose in the first place.
  it("puts the whole report on the scan command's stderr", async () => {
    await populate(scratch, ["bad.stub", "boom.stub", "warn.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toBe(
      "⚠ 1 file(s) had recoverable parse errors.\n" +
        "⚠ 1 file(s) could not be parsed and were left out of the IR.\n" +
        "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1\n" +
        `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}\n` +
        `    bad.stub: ${REFUSAL}\n` +
        `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}\n` +
        "    boom.stub: plugin exploded\n",
    )
  })

  it("puts the warnings above the summary they qualify, not below it", async () => {
    // The sink fires inside `runScan` now, so in any merged view the warnings precede the
    // stdout summary where they used to follow it. Per-stream bytes are identical, which is
    // exactly why the assertion above cannot see this. Pinned rather than left to drift: the
    // last thing on screen is now the kept / dropped line and the paths, which is the part a
    // reader acts on.
    await populate(scratch, ["boom.stub", "ok.stub"])
    const merged = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout: merged,
      stderr: merged,
      env: {},
      cwd: scratch,
    })
    const lines = merged.text().trimEnd().split("\n")
    expect(lines[0]).toContain("contributed no Symbols")
    expect(lines.findIndex((l) => l.includes("kept ·"))).toBeGreaterThan(
      lines.findIndex((l) => l.includes("a plugin threw")),
    )
  })
})

describe("reportScanIncidents — the lines a real scan cannot be made to produce", () => {
  function reportWith(overrides: Partial<ScanReport>): ScanReport {
    return {
      irPath: null,
      workspaceMdPath: null,
      componentMdPaths: [],
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      parseErrorCount: 0,
      parseFailureCount: 0,
      timeoutCount: 0,
      skipped: [],
      extractionFailures: [],
      lspEnrichment: undefined,
      callResolutionLine: "",
      unresolvedCalls: [],
      configSource: null,
      workspaceRoot: "/repo",
      coverageFault: null,
      unrepresentableFiles: [],
      exitCode: EXIT.SUCCESS,
      ...overrides,
    }
  }

  function linesFrom(report: ScanReport, label: string | null): string[] {
    const lines: string[] = []
    reportScanIncidents(report, (m) => lines.push(m), label)
    return lines
  }

  it("names the effect-classify timeout budget", () => {
    expect(linesFrom(reportWith({ timeoutCount: 4 }), null)).toEqual([
      "⚠ 4 effect classification(s) hit the per-call timeout budget.",
    ])
  })

  it("gives every LSP line the glyph and the label, including the request census", () => {
    // The census line used to be indented and glyphless. It has its own condition and fires
    // when neither line above it did, so in a two-scan diff nothing could attribute it.
    const lines = linesFrom(
      reportWith({
        lspEnrichment: {
          enabled: true,
          filesEnriched: 8,
          filesFellBack: 2,
          languagesDisabled: [makeLanguageId("ts")],
          requestsIssued: 40,
          requestsTimedOut: 3,
          requestsFailed: 1,
        },
      }),
      "head (working tree)",
    )
    expect(lines).toEqual([
      "⚠ head (working tree): LSP enrichment fell back for 2 file(s); IR field values in those files remain at the untyped tier.",
      "⚠ head (working tree): LSP disabled mid-run for language(s): ts.",
      "⚠ head (working tree): LSP requests: 40 issued · 3 timed out · 1 failed.",
    ])
  })

  it("emits the census alone when nothing fell back and no language was disabled", () => {
    const lines = linesFrom(
      reportWith({
        lspEnrichment: {
          enabled: true,
          filesEnriched: 10,
          filesFellBack: 0,
          languagesDisabled: [],
          requestsIssued: 10,
          requestsTimedOut: 0,
          requestsFailed: 2,
        },
      }),
      null,
    )
    expect(lines).toEqual(["⚠ LSP requests: 10 issued · 0 timed out · 2 failed."])
  })

  it("caps each reason's listing and leaves the tail unlabelled with the rest of it", () => {
    const skipped = Array.from({ length: 12 }, (_, i) => ({
      path: `src/f${i}.ts`,
      reason: "extraction-failed" as const,
      detail: "plugin exploded",
    }))
    const lines = linesFrom(
      reportWith({
        skipped,
        extractionFailures: skipped.map((s) => ({ file: s.path, message: s.detail })),
      }),
      'base ref "main"',
    )
    expect(lines[0]).toBe(
      '⚠ base ref "main": 12 file(s) contributed no Symbols: extraction-failed=12',
    )
    expect(lines[1]).toContain('⚠ base ref "main": extraction-failed (12) — ')
    expect(lines.slice(2, 12)).toEqual(
      skipped.slice(0, 10).map((s) => `    ${s.path}: ${s.detail}`),
    )
    expect(lines.at(-1)).toBe("    …and 2 more")
  })

  it("says nothing about a tail when the cap is met exactly", () => {
    // The one size the guard exists for, and the size every other case here steps over: at
    // ten there is nothing hidden, and a tail would read `…and 0 more` — a truthful count of
    // nothing on a line whose whole job is to say files are missing.
    const skipped = Array.from({ length: 10 }, (_, i) => ({
      path: `vendor/big${i}.js`,
      reason: "over-size" as const,
      detail: "2100000 > 1048576",
    }))
    const lines = linesFrom(reportWith({ skipped }), null)
    expect(lines.filter((l) => l.startsWith("    "))).toHaveLength(10)
    expect(lines.some((l) => l.startsWith("    …and"))).toBe(false)
  })

  it("gives each reason its own ten, so a flood cannot hide the one that gates", () => {
    // A single cap across the whole listing is the failure: eleven over-size files would
    // spend it, and the one file that set the exit code would be inside `…and N more`. §5.6
    // promises the opposite — a reader handed a non-zero status is told which files earned it.
    const flood = Array.from({ length: 11 }, (_, i) => ({
      path: `vendor/big${i}.js`,
      reason: "over-size" as const,
      detail: "2100000 > 1048576",
    }))
    const gating = { path: "src/route.ts", reason: "extraction-failed" as const, detail: "boom" }
    const lines = linesFrom(
      reportWith({
        skipped: [...flood, gating],
        extractionFailures: [{ file: gating.path, message: gating.detail }],
      }),
      null,
    )
    expect(lines).toContain("    …and 1 more")
    expect(lines).toContain("    src/route.ts: boom")
  })

  it("names every reason's files, with the detail the core wrote", () => {
    const lines = linesFrom(
      reportWith({
        // Handed over in an order no rule produces — the order a walk of some workspace or
        // other would have produced. What comes out must not depend on it.
        skipped: [
          { path: "src/route.ts", reason: "extraction-failed", detail: "plugin exploded" },
          { path: "src/x.weird", reason: "unroutable", detail: "no plugin claims it" },
          {
            path: "src/slow.ts",
            reason: "parse-timeout",
            detail: "extraction reached 5123ms, exceeding parseTimeoutMs (5000ms)",
          },
          { path: "vendor/bundle.js", reason: "over-size", detail: "2100000 > 1048576" },
          { path: "src/broken.ts", reason: "parse-failed", detail: "unexpected token at 3:7" },
          { path: "src/locked.ts", reason: "unreadable", detail: "EACCES: permission denied" },
        ],
        extractionFailures: [{ file: "src/route.ts", message: "plugin exploded" }],
      }),
      null,
    )
    // The order the schema's `reason` enum declares, not scan order: the groups arrive in the
    // order the census named them, and neither depends on where in the workspace the files sat.
    expect(lines[0]).toBe(
      "⚠ 6 file(s) contributed no Symbols: over-size=1, unreadable=1, unroutable=1, parse-failed=1, parse-timeout=1, extraction-failed=1",
    )
    expect(lines.filter((l) => l.startsWith("    "))).toEqual([
      "    vendor/bundle.js: 2100000 > 1048576",
      "    src/locked.ts: EACCES: permission denied",
      "    src/x.weird: no plugin claims it",
      "    src/broken.ts: unexpected token at 3:7",
      "    src/slow.ts: extraction reached 5123ms, exceeding parseTimeoutMs (5000ms)",
      "    src/route.ts: plugin exploded",
    ])
  })

  it("sends each reason somewhere different, and names the setting where there is one", () => {
    // The line used to be neutral about six reasons that want six different responses.
    const advice = (reason: SkippedFile["reason"], detail?: string): string => {
      const entry = detail === undefined ? { path: "f", reason } : { path: "f", reason, detail }
      const found = linesFrom(reportWith({ skipped: [entry] }), null).find((l) =>
        l.startsWith(`⚠ ${reason} (1) — `),
      )
      if (found === undefined) throw new Error(`no group line for ${reason}`)
      return found
    }
    expect(advice("over-size")).toContain("maxFileSizeBytes")
    expect(advice("parse-timeout")).toContain("parseTimeoutMs")
    expect(advice("parse-timeout")).toContain("re-run")
    // Two producers: a stat or read that failed at discovery, and a file deleted between
    // discovery and the read before extraction. Advice true for one only would be false half
    // the time, and there is nothing in the entry that says which happened.
    expect(advice("unreadable")).toContain("permission")
    expect(advice("unreadable")).toContain("re-run")
    // Two producers, like `unreadable`: the router refusing an extension, and a path segment
    // holding a Symbol id separator. Advice true for one only would be false half the time, and
    // nothing in the entry says which happened.
    expect(advice("unroutable")).toContain("plugin set")
    expect(advice("unroutable")).toContain("renaming that segment")
    expect(advice("parse-failed")).toContain("refused")
    expect(advice("extraction-failed")).toContain("threw")
    // The split the reason's own schema docstring draws: machine-dependent says re-run,
    // deterministic says fix something.
    expect(advice("parse-failed")).toContain("Deterministic")
    expect(advice("parse-timeout")).toContain("Machine-dependent")
  })

  it("lists a file the core gave no detail without a dangling separator", () => {
    // Absent and empty are both reachable, and they render the same. `throw ""` reaches
    // `describeThrown` and comes back as `""`, and discovery takes `(error as Error).message`
    // unguarded, so an `Error` built with no message leaves one behind too. Either way
    // `    src/quiet.ts: ` would be a path, a colon, and silence.
    for (const skipped of [
      [{ path: "src/quiet.ts", reason: "over-size" as const }],
      [{ path: "src/quiet.ts", reason: "over-size" as const, detail: "" }],
    ]) {
      expect(linesFrom(reportWith({ skipped }), null).at(-1)).toBe("    src/quiet.ts")
    }
  })

  it("says nothing when the scan lost nothing", () => {
    expect(linesFrom(reportWith({}), null)).toEqual([])
  })

  it("names a config that sits below the workspace root, labelled like the rest", () => {
    const lines = linesFrom(
      reportWith({ configSource: "/repo/apps/web/aburi.json", workspaceRoot: "/repo" }),
      'base ref "main"',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⚠ base ref "main": Config /repo/apps/web/aburi.json sits below')
  })
})

describe("aburi explain — the scan it ran for you", () => {
  it("names the withdrawal behind a No matches answer", async () => {
    await populate(scratch, ["bad.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "bad_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    // Still not found — the Symbol genuinely is not in the IR. The difference is that the
    // reader is now told the file it would have come from was never parsed, instead of
    // reading an answer indistinguishable from "that Symbol does not exist".
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr.text()).toContain("1 file(s) could not be parsed and were left out of the IR.")
    expect(stderr.text()).toContain('No matches for "bad_stub".')
  })

  it("exits 3 when a plugin threw, even though it found what it was asked for", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(stdout.text()).toContain("ok_stub")
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toContain("extraction-failed (1)")
    expect(stderr.text()).toContain("boom.stub: plugin exploded")
  })

  it("exits 3 rather than 1 when the answer it could not find may be the fault's", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "boom_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.GATE)
  })

  it("exits 3 rather than 2 when the candidate list may itself be short", async () => {
    await populate(scratch, ["boom.stub", "ok.stub", "ok2.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(stdout.text()).toContain("Multiple matches")
    expect(code).toBe(EXIT.GATE)
  })

  it("says nothing about incidents when it read an IR off disk", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    await runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" })
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    // No scan ran, so there is no incident to report and no exit code to inherit. The live
    // signal fired when `aburi scan` wrote the file.
    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr.text()).toBe("")
  })

  it("says nothing for an explicit --ir either, for the same reason", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const out = resolve(scratch, "pinned")
    await runScan({ cwd: scratch, outputDir: out, format: "json" })
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok_stub", "--ir", resolve(out, "aburi.ir.json")],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr.text()).toBe("")
  })
})

describe("aburi diff — both scans it ran for you", () => {
  it("labels each side, and never calls the head by the ref spec's head label", async () => {
    await populate(scratch, ["warn.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..v1.1.0",
      git: gitWith(["bad.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings).toContain(
      '⚠ base ref "main": 1 file(s) could not be parsed and were left out of the IR.',
    )
    expect(warnings).toContain("⚠ head (working tree): 1 file(s) had recoverable parse errors.")
    // §6.4 — the head is always the current checkout, whatever the ref spec calls it. A
    // `head ref "v1.1.0"` label would name a revision this scan never read.
    expect(warnings.join("\n")).not.toContain("v1.1.0")
  })

  it("gates on a plugin fault at either side and names which, with no clause triggered", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
    // The gate is `exitCode !== SUCCESS`, which does not by itself say a plugin threw, so the
    // wording is derived from what each side reported — count included, and attributed to the
    // side that reported it. A second reason gates now, and a sentence about a joined list of
    // sides would state one side's cause about both.
    expect(warnings).toContain(
      "⚠ base: a plugin exception withdrew 1 file(s). This run exits 3 even though " +
        "the diff was written. Fix it, or the comparison is against a workspace one side could not read.",
    )
  })

  it("names both sides when both scans faulted", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    })
    expect(report.faultedScans).toEqual(["base", "head"])
  })

  it("says the counts can be wrong for a reason skippedFiles does not cover", async () => {
    await populate(scratch, ["warn.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["warn.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    // A file with recoverable errors is *in* both IRs, so it is in no `stats.skippedFiles`
    // and nothing about it becomes `unknown`. Its Symbol set can still be short, and the
    // added / removed counts then move with no file having gone missing.
    expect(warnings.join("\n")).toContain("recoverable parse errors")
    expect(warnings.join("\n")).toContain("added / removed")
  })

  it("keeps all three lines when a file is lost on both sides", async () => {
    await populate(scratch, ["bad.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["bad.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    // Two per-scan facts and one diff-level synthesis. They overlap on purpose: the first
    // two say what each revision failed to read, the third says the comparison never
    // happened — which neither scan is in a position to know.
    expect(warnings.filter((m) => m.includes("contributed no Symbols"))).toHaveLength(2)
    expect(warnings.filter((m) => m.includes("skipped by both scans"))).toHaveLength(1)
    // And no fourth. A refusal is not a recoverable error, and neither scan faulted, so the
    // two lines that qualify the counts have nothing to say here.
    expect(warnings.join("\n")).not.toContain("recoverable parse errors")
    expect(warnings.join("\n")).not.toContain("exits 3")
  })

  it("names a fault the documents remember, without gating on someone else's run", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const out = resolve(scratch, "out")
    await runScan({ cwd: scratch, outputDir: out, format: "json" })
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: resolve(out, "aburi.ir.json"),
      head: resolve(out, "aburi.ir.json"),
      outputDir: resolve(scratch, "diff-out"),
      warn: (m) => warnings.push(m),
    })
    // No scan ran here, which is not the same answer as two clean scans.
    expect(report.faultedScans).toBeNull()
    // `stats.skippedFiles[].reason` persists `extraction-failed`, so this mode can see that a
    // plugin threw when the documents were written even though it never watched it happen.
    expect(warnings.join("\n")).toContain("base IR records 1 file(s) a plugin threw on")
    expect(warnings.join("\n")).toContain("head IR records 1 file(s) a plugin threw on")
    expect(warnings.join("\n")).toContain("boom.stub")
    // Warned, not gated: the fault already had its exit code in the run that hit it, and these
    // are documents the caller pinned deliberately.
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    // `parseErrorCount` lives on the scan report, never in the IR, so this mode cannot know
    // whether either document was written from a clean parse.
    expect(warnings.join("\n")).not.toContain("recoverable parse errors")
  })

  it("attributes a recorded fault to the document that holds it", async () => {
    // Base and head must differ, or reading one document twice would satisfy any attribution.
    // Beside the head workspace rather than inside it: a base nested under `scratch` is part of
    // the head scan's own tree, so the head document would hold the base's files as well.
    const baseWorkspace = await mkdtemp(resolve(tmpdir(), "aburi-scan-incidents-base-"))
    await populate(baseWorkspace, ["boom.stub", "ok.stub"])
    await populate(scratch, ["ok.stub"])
    const baseOut = resolve(scratch, "base-out")
    const headOut = resolve(scratch, "head-out")
    await runScan({ cwd: baseWorkspace, outputDir: baseOut, format: "json" })
    await runScan({ cwd: scratch, outputDir: headOut, format: "json" })
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      base: resolve(baseOut, "aburi.ir.json"),
      head: resolve(headOut, "aburi.ir.json"),
      outputDir: resolve(scratch, "diff-out"),
      warn: (m) => warnings.push(m),
    })
    await rm(baseWorkspace, { recursive: true, force: true })
    expect(warnings.join("\n")).toContain("base IR records 1 file(s) a plugin threw on")
    expect(warnings.join("\n")).not.toContain("head IR records")
  })

  it("stays quiet in file mode for documents no plugin threw on", async () => {
    await populate(scratch, ["bad.stub", "ok.stub"])
    const out = resolve(scratch, "out")
    await runScan({ cwd: scratch, outputDir: out, format: "json" })
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: resolve(out, "aburi.ir.json"),
      head: resolve(out, "aburi.ir.json"),
      outputDir: resolve(scratch, "diff-out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings.join("\n")).not.toContain("a plugin threw on")
  })

  it("keeps the clause alongside the fault, so neither hides the other", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub", "extra.stub"]),
      outputDir: resolve(scratch, "out"),
      failOn: "removed",
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    // Labelled, so a two-scan run says which side lost the file; the per-file line under it
    // stays indented and unlabelled and is attributed by the line above.
    expect(warnings.join("\n")).toContain('⚠ base ref "main": extraction-failed (1)')
    expect(warnings).toContain("    boom.stub: plugin exploded")
    // Rendering the clause is the CLI wrapper's job, so what is pinned here is that the fault
    // did not swallow it: `triggered` survives, and it still formats as the gate that tripped.
    const triggered = report.triggered
    expect(triggered).not.toBeNull()
    if (triggered === null) return
    expect(formatFailOnMessage(triggered)).toContain("removed")
  })
})

describe("runExplain — the report reaches a programmatic caller too", () => {
  it("hands the incidents to the supplied sink rather than to a stream", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const warnings: string[] = []
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ok_stub",
      warn: (m) => warnings.push(m),
    })
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("plugin threw")
  })
})
