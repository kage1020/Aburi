import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  EXIT,
  reportScanIncidents,
  runCli,
  runDiff,
  runExplain,
  runScan,
  type ScanReport,
} from "../src"
import { gitWith, populate } from "./stub-language"

/**
 * What a scan that read almost none of the workspace is worth.
 *
 * It used to be worth exit 0. `runScan` consulted `extractionFailures` and nothing else, so a
 * run that discovered 1200 files and withdrew all of them wrote an IR, went green, and diffed
 * against the next one as `+0 -0 ~0` — passing every `--fail-on` gate. `requireLanguagePlugin`
 * closed one route to that shape and its own docblock says why the shape is dangerous; these
 * are the rest of the routes.
 */

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
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-coverage-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scanIn(files: readonly string[], warnings: string[] = []): Promise<ScanReport> {
  await populate(scratch, files)
  return runScan({
    cwd: scratch,
    outputDir: resolve(scratch, "out"),
    format: "json",
    incidents: { warn: (m: string) => warnings.push(m) },
  })
}

describe("aburi scan — a workspace it could not read", () => {
  it("gates when every file discovered was withdrawn", async () => {
    const warnings: string[] = []
    const report = await scanIn(["bad.stub"], warnings)
    expect(report.totalFiles).toBe(1)
    expect(report.parsedFiles).toBe(0)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("1 file(s) discovered, 0 parsed")
  })

  it("names the reason that took the most of them", async () => {
    const warnings: string[] = []
    // Discovery sorts by path, so the minority reason is the one seen first. The line has to
    // report the majority, not the earliest.
    await scanIn(["bad.stub", "boom-a.stub", "boom-b.stub"], warnings)
    expect(warnings.join("\n")).toContain("3 file(s) discovered, 0 parsed — 2 as extraction-failed")
  })

  it("breaks a tie on the reason enum rather than on the order of the walk", async () => {
    const warnings: string[] = []
    // One file each, and the one that should win is the one discovery reaches second —
    // `boom.stub` sorts before `zz-bad.stub`. Left to insertion order the line would name
    // `extraction-failed`, and the same workspace under different filenames would name the
    // other. A reader comparing two runs needs the sentence to be about the losses.
    await scanIn(["boom.stub", "zz-bad.stub"], warnings)
    expect(warnings.join("\n")).toContain("2 file(s) discovered, 0 parsed — 1 as parse-failed")
  })

  it("still writes the IR, so a reader gets the artifact and the code", async () => {
    const report = await scanIn(["bad.stub"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
  })

  it("gates when discovery found nothing to scan at all", async () => {
    // A language plugin is configured and claims `.stub`; the workspace has none. An `ignore`
    // glob that ate the tree, a `components[].roots` that matches nothing, and a plugin set
    // that claims no extension in this repository all land here.
    const warnings: string[] = []
    const report = await scanIn([], warnings)
    expect(report.totalFiles).toBe(0)
    expect(report.exitCode).toBe(EXIT.GATE)
    const line = warnings.join("\n")
    expect(line).toContain("No file was discovered")
    expect(line).toContain("ignore")
    expect(line).toContain("components[].roots")
    // Not the "discovered, 0 parsed" wording: there is nothing to name a reason for, and the
    // first move is discovery rather than a plugin.
    expect(line).not.toContain("0 parsed")
  })

  it("stays green for a scan that lost most of the workspace but not all of it", async () => {
    // The unconditional gate is `parsedFiles === 0` and nothing else. Anything above that is
    // the opt-in floor's business, which this workspace does not set.
    const warnings: string[] = []
    const report = await scanIn(["bad.stub", "boom.stub", "ok.stub"], warnings)
    expect(report.parsedFiles).toBe(1)
    expect(report.totalFiles).toBe(3)
    expect(report.coverageFault).toBeNull()
    // Still exits 3 — but for the plugin exception, which is a different clause.
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).not.toContain("discovered, 0 parsed")
  })

  it("stays green, and silent, for a scan that read everything", async () => {
    const warnings: string[] = []
    const report = await scanIn(["ok.stub"], warnings)
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings).toEqual([])
  })
})

describe("config.minParsedFileRatio — the floor a workspace opts into", () => {
  async function scanWithFloor(
    files: readonly string[],
    floor: number | undefined,
    warnings: string[] = [],
  ): Promise<ScanReport> {
    await populate(scratch, files)
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.dev/schema/aburi.config.v1.json",
        languages: ["./lang-stub.mjs"],
        ...(floor === undefined ? {} : { minParsedFileRatio: floor }),
      }),
      "utf8",
    )
    return runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })
  }

  it("does nothing when the workspace never set one", async () => {
    const report = await scanWithFloor(["bad.stub", "ok.stub"], undefined)
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("gates when coverage falls below it, naming both counts and the floor", async () => {
    const warnings: string[] = []
    const report = await scanWithFloor(["bad.stub", "ok.stub"], 0.9, warnings)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("1 of 2 file(s) parsed (50%), below the")
    expect(warnings.join("\n")).toContain("minParsedFileRatio floor of 90%")
  })

  it("does not gate at the floor exactly", async () => {
    // `<` and not `<=`: a floor of 0.5 is a statement about what is unacceptable, and half
    // is not below half. The same reading `--fail-on`'s thresholds already use.
    const report = await scanWithFloor(["bad.stub", "ok.stub"], 0.5)
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("counts every reason a file went missing, not the machine-dependent one only", async () => {
    // `parse-timeout` is the reason whose loss varies by machine, which is why it is the one
    // a floor is usually reached for. It is not the only one that hides a blind spot, and
    // which reason produced the loss decides the fix rather than whether coverage collapsed.
    const warnings: string[] = []
    const report = await scanWithFloor(["boom.stub", "ok.stub"], 1, warnings)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("1 of 2 file(s) parsed (50%)")
  })

  it("leaves an empty workspace to the unconditional gate rather than to a division", async () => {
    const warnings: string[] = []
    const report = await scanWithFloor([], 0.9, warnings)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("No file was discovered")
    expect(warnings.join("\n")).not.toContain("minParsedFileRatio")
  })

  it("refuses a floor nothing can fall below, and one nothing can reach", async () => {
    for (const floor of [0, 1.5]) {
      await expect(scanWithFloor(["ok.stub"], floor)).rejects.toThrow(/minParsedFileRatio/)
    }
  })
})

describe("reportScanIncidents — the fault and the code cannot disagree", () => {
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
      exitCode: EXIT.SUCCESS,
      ...overrides,
    }
  }

  function linesFrom(report: ScanReport, label: string | null): string[] {
    const lines: string[] = []
    reportScanIncidents(report, (m) => lines.push(m), label)
    return lines
  }

  it("puts the coverage line first, above the census that explains it", () => {
    const lines = linesFrom(
      reportWith({
        totalFiles: 1200,
        skipped: Array.from({ length: 1200 }, (_, i) => ({
          path: `src/f${i}.ts`,
          reason: "parse-failed" as const,
          detail: "refused",
        })),
        coverageFault: {
          kind: "nothing-parsed",
          totalFiles: 1200,
          dominant: "parse-failed",
          dominantCount: 1200,
        },
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines[0]).toBe(
      "⚠ 1200 file(s) discovered, 0 parsed — 1200 as parse-failed. The IR is empty and will diff clean against any other empty IR.",
    )
    expect(lines[1]).toContain("1200 file(s) contributed no Symbols")
  })

  it("labels it like every other line it owns", () => {
    const lines = linesFrom(
      reportWith({
        coverageFault: { kind: "nothing-discovered" },
        exitCode: EXIT.GATE,
      }),
      'base ref "main"',
    )
    expect(lines[0]).toContain('⚠ base ref "main": No file was discovered')
  })

  it("says nothing when the scan read the workspace", () => {
    expect(linesFrom(reportWith({ totalFiles: 3, parsedFiles: 3 }), null)).toEqual([])
  })
})

describe("aburi diff and aburi explain — the scans they ran for you", () => {
  it("names coverage as the cause rather than falling back to did not exit clean", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["bad.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    // §6.7 says the wording is derived from what the scan actually reported "so a second
    // reason arrives with the code right and the message still true". This is that reason.
    expect(warnings.join("\n")).toContain("The base scan parsed none of the 1 file(s) it found")
    expect(warnings.join("\n")).not.toContain("plugin exception")
  })

  it("keeps the plugin exception's own wording", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("A plugin exception withdrew 1 file(s)")
  })

  it("gives explain the code and the line for the scan it ran", async () => {
    await populate(scratch, ["bad.stub"])
    const warnings: string[] = []
    const outcome = await runExplain({
      cwd: scratch,
      argument: "anything",
      warn: (m) => warnings.push(m),
    })
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("1 file(s) discovered, 0 parsed")
  })

  it("exits 3 from the command, with the IR on disk", async () => {
    await populate(scratch, ["bad.stub"])
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
    expect(stderr.text()).toContain("1 file(s) discovered, 0 parsed")
  })
})
