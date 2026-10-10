import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { makeLanguageId, type SkippedFile } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, formatFailOnMessage, runCli, runDiff, runExplain, runScan } from "../src"
import { incidentLinesFrom, MemStream, scanReportWith } from "./fixtures"
import { gitWith, populate } from "./stub-language"

const REFUSAL = "parse reported a non-recoverable error at 12:4 — unterminated string"

const PARSE_FAILED_ADVICE =
  "the language plugin refused the source. Deterministic: fix the file, or the plugin."
const EXTRACTION_FAILED_ADVICE =
  "a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean."

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-incidents-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — the report goes to the caller's sink", () => {
  it("returns the report and emits no incident line when no sink was given", async () => {
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
      "    warn.stub: 2:1 — stray token",
      "⚠ 1 file(s) could not be parsed and were left out of the IR.",
      "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1",
      `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}`,
      `    bad.stub: ${REFUSAL}`,
      `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      "    boom.stub: plugin exploded",
    ])
  })

  it("summarizes a file that reported more than one error, and says where recovery began", async () => {
    await populate(scratch, ["noisy.stub", "ok.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => lines.push(m) },
    })
    expect(lines).toEqual([
      "⚠ 1 file(s) had recoverable parse errors.",
      "    noisy.stub: 2 errors, first at 2:1 — stray token",
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
        "    warn.stub: 2:1 — stray token\n" +
        "⚠ 1 file(s) could not be parsed and were left out of the IR.\n" +
        "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1\n" +
        `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}\n` +
        `    bad.stub: ${REFUSAL}\n` +
        `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}\n` +
        "    boom.stub: plugin exploded\n",
    )
  })

  it("puts the warnings above the summary they qualify, not below it", async () => {
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
  it("groups unreleased parse trees by plugin, and states what the leak costs", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        treeReleaseFailures: [
          { plugin: "lang-stub", file: "a.ts", detail: "wasm heap is gone" },
          { plugin: "lang-stub", file: "b.ts", detail: "wasm heap is gone" },
          { plugin: "lang-other", file: "c.rs", detail: "releaseTree is a list, not a function" },
        ],
      }),
      null,
    )

    expect(lines).toEqual([
      "⚠ 3 parse tree(s) were not released by the plugin that built them. A tree a plugin does not free is not reclaimed by the garbage collector, so a long enough run exhausts the parser's heap.",
      "    lang-stub (2) — a.ts: wasm heap is gone",
      "    lang-other (1) — c.rs: releaseTree is a list, not a function",
    ])
  })

  it("names the framework ids a plugin-named frameworks value stands for, ahead of the tree leaks", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        treeReleaseFailures: [{ plugin: "lang-stub", file: "a.ts", detail: "gone" }],
        pluginNamedFrameworks: [
          { component: "app", value: "acme-kit", frameworkIds: ["acme-rpc", "acme-web"] },
          { component: "web", value: "lang-typescript", frameworkIds: [] },
        ],
      }),
      "head",
    )

    expect(lines.slice(0, 2)).toEqual([
      '⚠ head: Component "app" lists "acme-kit" in frameworks, which names a plugin, not a framework; the IR carries it as written. Write "acme-rpc" or "acme-web".',
      '⚠ head: Component "web" lists "lang-typescript" in frameworks, which names a plugin, not a framework; the IR carries it as written. That plugin provides no framework: remove it, or write the framework id the component is built on.',
    ])
    expect(lines[2]).toContain("parse tree(s) were not released")
  })

  it("says nothing about parse trees when every plugin freed its own", () => {
    expect(incidentLinesFrom(scanReportWith({ treeReleaseFailures: [] }), null)).toEqual([])
  })

  it("names every file behind the recoverable-error count, uncapped", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        parseErrorFiles: Array.from({ length: 12 }, (_, i) => ({
          path: `src/c${i}.tsx`,
          detail: "3:5 — syntax error",
        })),
        parseErrorCount: 12,
      }),
      null,
    )

    expect(lines[0]).toBe("⚠ 12 file(s) had recoverable parse errors.")
    expect(lines.slice(1)).toEqual(
      Array.from({ length: 12 }, (_, i) => `    src/c${i}.tsx: 3:5 — syntax error`),
    )
    expect(lines.join("\n")).not.toContain("more")
  })

  it("leaves the per-file lines unlabelled, like every other listing", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        parseErrorFiles: [{ path: "src/a.tsx", detail: "3:5 — syntax error" }],
        parseErrorCount: 1,
      }),
      'base ref "main"',
    )

    expect(lines).toEqual([
      '⚠ base ref "main": 1 file(s) had recoverable parse errors.',
      "    src/a.tsx: 3:5 — syntax error",
    ])
  })

  it("names the effect-classify timeout budget", () => {
    expect(incidentLinesFrom(scanReportWith({ timeoutCount: 4 }), null)).toEqual([
      "⚠ 4 effect classification(s) hit the per-call timeout budget.",
    ])
  })

  it("gives every LSP line the glyph and the label, including the request census", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
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
    const lines = incidentLinesFrom(
      scanReportWith({
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

  it("says what the typed tier bought, on a run every other counter calls healthy", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        lspEnrichment: {
          enabled: true,
          filesEnriched: 10,
          filesFellBack: 0,
          languagesDisabled: [],
          requestsIssued: 22,
          requestsTimedOut: 0,
          requestsFailed: 0,
          hintsProduced: 0,
          hintsConsumed: 0,
          hintsRejected: {
            unparseableHover: 9,
            ownerClassNotFound: 2,
            memberNotFound: 1,
            kindMismatch: 0,
            targetDropped: 0,
          },
        },
      }),
      null,
    )
    expect(lines).toEqual(["⚠ LSP receiver hints: 0 produced · 0 resolved a call · 12 rejected."])
  })

  it("stays quiet when the run neither produced nor refused a hint", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        lspEnrichment: {
          enabled: true,
          filesEnriched: 10,
          filesFellBack: 0,
          languagesDisabled: [],
          requestsIssued: 10,
          requestsTimedOut: 0,
          requestsFailed: 0,
          hintsProduced: 0,
          hintsConsumed: 0,
          hintsRejected: {
            unparseableHover: 0,
            ownerClassNotFound: 0,
            memberNotFound: 0,
            kindMismatch: 0,
            targetDropped: 0,
          },
        },
      }),
      null,
    )
    expect(lines).toEqual([])
  })

  it("reports a healthy typed tier too, so the line is a census and not an alarm", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        lspEnrichment: {
          enabled: true,
          filesEnriched: 10,
          filesFellBack: 0,
          languagesDisabled: [],
          requestsIssued: 40,
          requestsTimedOut: 0,
          requestsFailed: 0,
          hintsProduced: 30,
          hintsConsumed: 28,
          hintsRejected: {
            unparseableHover: 0,
            ownerClassNotFound: 0,
            memberNotFound: 0,
            kindMismatch: 0,
            targetDropped: 2,
          },
        },
      }),
      null,
    )
    expect(lines).toEqual(["⚠ LSP receiver hints: 30 produced · 28 resolved a call · 2 rejected."])
  })

  it("caps each reason's listing and leaves the tail unlabelled with the rest of it", () => {
    const skipped = Array.from({ length: 12 }, (_, i) => ({
      path: `src/f${i}.ts`,
      reason: "extraction-failed" as const,
      detail: "plugin exploded",
    }))
    const lines = incidentLinesFrom(
      scanReportWith({
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
    const skipped = Array.from({ length: 10 }, (_, i) => ({
      path: `vendor/big${i}.js`,
      reason: "over-size" as const,
      detail: "2100000 > 1048576",
    }))
    const lines = incidentLinesFrom(scanReportWith({ skipped }), null)
    expect(lines.filter((l) => l.startsWith("    "))).toHaveLength(10)
    expect(lines.some((l) => l.startsWith("    …and"))).toBe(false)
  })

  it("gives each reason its own ten, so a flood cannot hide the one that gates", () => {
    const flood = Array.from({ length: 11 }, (_, i) => ({
      path: `vendor/big${i}.js`,
      reason: "over-size" as const,
      detail: "2100000 > 1048576",
    }))
    const gating = { path: "src/route.ts", reason: "extraction-failed" as const, detail: "boom" }
    const lines = incidentLinesFrom(
      scanReportWith({
        skipped: [...flood, gating],
        extractionFailures: [{ file: gating.path, message: gating.detail }],
      }),
      null,
    )
    expect(lines).toContain("    …and 1 more")
    expect(lines).toContain("    src/route.ts: boom")
  })

  it("names every reason's files, with the detail the core wrote", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
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
          {
            path: "src/vanished.ts",
            reason: "unreadable",
            detail: "ENOENT: no such file or directory",
          },
        ],
        extractionFailures: [{ file: "src/route.ts", message: "plugin exploded" }],
      }),
      null,
    )
    expect(lines[0]).toBe(
      "⚠ 6 file(s) contributed no Symbols: over-size=1, unreadable=1, unroutable=1, parse-failed=1, parse-timeout=1, extraction-failed=1",
    )
    expect(lines.filter((l) => l.startsWith("    "))).toEqual([
      "    vendor/bundle.js: 2100000 > 1048576",
      "    src/vanished.ts: ENOENT: no such file or directory",
      "    src/x.weird: no plugin claims it",
      "    src/broken.ts: unexpected token at 3:7",
      "    src/slow.ts: extraction reached 5123ms, exceeding parseTimeoutMs (5000ms)",
      "    src/route.ts: plugin exploded",
    ])
  })

  it("sends each reason somewhere different, and names the setting where there is one", () => {
    const advice = (reason: SkippedFile["reason"], detail?: string): string => {
      const entry = detail === undefined ? { path: "f", reason } : { path: "f", reason, detail }
      const found = incidentLinesFrom(scanReportWith({ skipped: [entry] }), null).find((l) =>
        l.startsWith(`⚠ ${reason} (1) — `),
      )
      if (found === undefined) throw new Error(`no group line for ${reason}`)
      return found
    }
    expect(advice("over-size")).toContain("maxFileSizeBytes")
    expect(advice("parse-timeout")).toContain("parseTimeoutMs")
    expect(advice("parse-timeout")).toContain("re-run")
    expect(advice("unreadable")).toContain("re-run")
    expect(advice("unreadable")).not.toContain("permission")
    expect(advice("unreadable")).toContain("ends the run")
    expect(advice("unreadable")).toContain("stopped being files")
    expect(advice("unroutable")).toContain("plugin set")
    expect(advice("unroutable")).toContain("renaming that segment")
    expect(advice("parse-failed")).toContain("refused")
    expect(advice("extraction-failed")).toContain("threw")
    expect(advice("parse-failed")).toContain("Deterministic")
    expect(advice("parse-timeout")).toContain("Machine-dependent")
  })

  it("lists a file the core gave no detail without a dangling separator", () => {
    for (const skipped of [
      [{ path: "src/quiet.ts", reason: "over-size" as const }],
      [{ path: "src/quiet.ts", reason: "over-size" as const, detail: "" }],
    ]) {
      expect(incidentLinesFrom(scanReportWith({ skipped }), null).at(-1)).toBe("    src/quiet.ts")
    }
  })

  it("names a config that sits below the workspace root, labelled like the rest", () => {
    const lines = incidentLinesFrom(
      scanReportWith({ configSource: "/repo/apps/web/aburi.json", workspaceRoot: "/repo" }),
      'base ref "main"',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⚠ base ref "main": Config /repo/apps/web/aburi.json sits below')
  })

  it("stays quiet about a config the caller pinned, however far from the root it is", () => {
    expect(
      incidentLinesFrom(
        scanReportWith({
          configSource: "/repo/aburi.json",
          workspaceRoot: "/tmp/aburi-worktree-x/base",
          configPinnedByCaller: true,
        }),
        'base ref "main"',
      ),
    ).toEqual([])
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
    expect(warnings).toContain("    warn.stub: 2:1 — stray token")
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
    expect(warnings).toContain(
      "⚠ base: extraction withdrew 1 file(s). This run exits 3 even though " +
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
    expect(warnings.join("\n")).toContain("recoverable parse errors")
    expect(warnings.join("\n")).toContain("added / removed")
    expect(warnings).toEqual([
      '⚠ base ref "main": 1 file(s) had recoverable parse errors.',
      "    warn.stub: 2:1 — stray token",
      "⚠ head (working tree): 1 file(s) had recoverable parse errors.",
      "    warn.stub: 2:1 — stray token",
      expect.stringContaining("added / removed"),
    ])
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
    expect(warnings.filter((m) => m.includes("contributed no Symbols"))).toHaveLength(2)
    expect(warnings.filter((m) => m.includes("skipped by both scans"))).toHaveLength(1)
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
    expect(report.faultedScans).toBeNull()
    expect(warnings.join("\n")).toContain("base IR records 1 file(s) withdrawn during extraction")
    expect(warnings.join("\n")).toContain("head IR records 1 file(s) withdrawn during extraction")
    expect(warnings.join("\n")).toContain("boom.stub")
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings.join("\n")).not.toContain("recoverable parse errors")
  })

  it("attributes a recorded fault to the document that holds it", async () => {
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
    expect(warnings.join("\n")).toContain("base IR records 1 file(s) withdrawn during extraction")
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
    expect(warnings.join("\n")).not.toContain("withdrawn during extraction")
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
    expect(warnings.join("\n")).toContain('⚠ base ref "main": extraction-failed (1)')
    expect(warnings).toContain("    boom.stub: plugin exploded")
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

describe("aburi scan — a file withdrawn for a duplicate Symbol id", () => {
  it("reports it on the same lines a throw reaches, with the core's message", async () => {
    await populate(scratch, ["ok.stub", "twin.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => lines.push(m) },
    })
    expect(lines).toEqual([
      "⚠ 1 file(s) contributed no Symbols: extraction-failed=1",
      `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      '    twin.stub: two Symbols share the id "stub:twin.stub#twin_stub" (lines 1 and 7); ' +
        "the language plugin gave two declarations one qualified name, and nothing it " +
        "reported separates them",
    ])
  })

  it("gates the run and still writes the IR the surviving file produced", async () => {
    await populate(scratch, ["ok.stub", "twin.stub"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBe(1)
    expect(report.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["twin.stub", "duplicate-symbol-id"],
    ])
  })

  it("earns the diff fault clause without claiming an exception", async () => {
    await populate(scratch, ["ok.stub", "twin.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.faultedScans).toEqual(["head"])
    expect(warnings.join("\n")).toContain("head: extraction withdrew 1 file(s)")
    expect(warnings.join("\n")).not.toContain("exception")
  })
})
