import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

describe("aburi scan — a name no Symbol id can hold", () => {
  it("lists it, keeps the rest, and lets explain answer out of it", async () => {
    // End to end: discovery records the file instead of ending the walk, the report groups it
    // under `unroutable` with its detail, and the Document names it — so `explain` asked about
    // something that would have lived there says the IR never analysed it rather than "no
    // matches". None of that needed a diff-side change: `stats.skippedFiles[].path` is held to
    // the shared path rule, which admits `#`.
    //
    // `#` and not `:` in the fixture: both are refused by the grammar, but NTFS reads `:` as an
    // alternate-data-stream separator, so a `:` file would pass here and be a different file on
    // Windows. `id.test.ts` covers `:` without touching a filesystem.
    await populate(scratch, ["ok.stub"])
    // Under a directory, so `explain` routes it as a path rather than as a name to match on
    // (`docs/cli-reference.md` — the file arm wants a `/`).
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src", "od#d.stub"), "odd", "utf8")
    const warnings: string[] = []
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.parsedFiles).toBe(1)
    expect(report.keptSymbols).toBe(1)
    const printed = warnings.join("\n")
    expect(printed).toContain("1 file(s) contributed no Symbols: unroutable=1")
    expect(printed).toContain("⚠ unroutable (1) — ")
    expect(printed).toContain(
      '    src/od#d.stub: its path segment "od#d.stub" contains "#", which a Symbol id is split on',
    )

    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/od#d.stub",
      irPath: resolve(scratch, "out", "aburi.ir.json"),
      warn: () => {},
    })
    expect(outcome.kind).toBe("unknown")
    expect(outcome.exitCode).toBe(EXIT.GATE)
  })

  it("trips the coverage gate when every file it found was one", async () => {
    const warnings: string[] = []
    await populate(scratch, ["od#d.stub"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("1 file(s) discovered, 0 parsed — 1 as unroutable")
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

  it("names every unnameable file, because this line is the only record of them", () => {
    // No fixture needed and none possible on Windows: the report is assembled here, so what a
    // reader is told about a file the artifact cannot hold is pinned on every platform.
    const lines = linesFrom(
      reportWith({
        totalFiles: 3,
        parsedFiles: 3,
        unrepresentableFiles: [
          { path: "src/v\\1/other.stub", segment: "v\\1" },
          { path: "src/v\\1/util.stub", segment: "v\\1" },
        ],
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines[0]).toContain("2 file(s) were left out of the IR and out of its counts")
    // The segment, not the file. A backslash in a directory name disqualifies every file
    // beneath it and each of those filenames is innocent, so a line blaming `util.stub` sends
    // the reader to rename the wrong thing.
    expect(lines[1]).toBe('    src/v\\1/other.stub: the segment "v\\1" holds a backslash')
    expect(lines[2]).toBe('    src/v\\1/util.stub: the segment "v\\1" holds a backslash')
  })

  it("caps the list the way every skip reason is capped", () => {
    const lines = linesFrom(
      reportWith({
        unrepresentableFiles: Array.from({ length: 12 }, (_, i) => ({
          path: `src/f${i}\\x.stub`,
          segment: `f${i}\\x.stub`,
        })),
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines).toHaveLength(12)
    expect(lines[11]).toBe("    …and 2 more")

    // Exactly the cap is the boundary the tail's guard exists for, and no other fixture in
    // this suite sits on it: eleven files hides a `>= 0` guard as readily as twelve does.
    const atCap = linesFrom(
      reportWith({
        unrepresentableFiles: Array.from({ length: 10 }, (_, i) => ({
          path: `src/f${i}\\x.stub`,
          segment: `f${i}\\x.stub`,
        })),
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(atCap).toHaveLength(11)
    expect(atCap.join("\\n")).not.toContain("more")
  })

  it("never prints a percentage as being below itself", () => {
    // 899/1000 is 89.9% against a floor of 90%. Rounding both to nearest gives
    // `parsed (90%), below the … floor of 90%`, which reads as a bug in the tool rather than
    // as a finding about the workspace. Rounding away from each other keeps the sentence true
    // for every pair that can reach this line.
    const lines = linesFrom(
      reportWith({
        totalFiles: 1000,
        parsedFiles: 899,
        coverageFault: { kind: "below-floor", parsedFiles: 899, totalFiles: 1000, floor: 0.9 },
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines[0]).toBe(
      "⚠ 899 of 1000 file(s) parsed (89%), below the minParsedFileRatio floor of 90%. " +
        "Raise the coverage, or lower the floor if this is what the workspace looks like now.",
    )
  })

  it("keeps the two apart wherever the pair sits", () => {
    // Each row collapses under a different rounding mistake. 199/200 against a floor of 1 is
    // the top of the range, where rounding the *share* to nearest prints `(100%), below … 100%`.
    // 902/1000 against 0.904 is where rounding the *floor* to nearest does the same — which
    // neither that row nor the one above can show, since 0.9 and 1 land on the same integer
    // whichever way they are rounded.
    const cases = [
      {
        parsedFiles: 199,
        totalFiles: 200,
        floor: 1,
        expected: "parsed (99%), below the",
        printed: "floor of 100%",
      },
      {
        parsedFiles: 902,
        totalFiles: 1000,
        floor: 0.904,
        expected: "parsed (90%), below the",
        printed: "floor of 91%",
      },
    ] as const
    for (const { expected, printed, ...fault } of cases) {
      const lines = linesFrom(
        reportWith({
          totalFiles: fault.totalFiles,
          parsedFiles: fault.parsedFiles,
          coverageFault: { kind: "below-floor", ...fault },
          exitCode: EXIT.GATE,
        }),
        null,
      )
      expect(lines[0]).toContain(expected)
      expect(lines[0]).toContain(printed)
    }
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
    // §6.5 says the wording is derived from what the scan actually reported "so a second
    // reason arrives with the code right and the message still true". This is that reason.
    expect(warnings.join("\n")).toContain("base: none of the 1 file(s) it found parsed")
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
    expect(warnings.join("\n")).toContain("base: a plugin exception withdrew 1 file(s)")
  })

  it("says each faulted side's own cause rather than one side's about both", async () => {
    // The base threw; the head found files and parsed none of them. A cross-side count, or the
    // first side's fault, stated about "the base and head scan" is a false sentence — and this
    // is the line a reader greps out of a CI log to account for the exit code.
    await populate(scratch, ["bad.stub", "zz-bad.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual(["base", "head"])
    expect(warnings.join("\n")).toContain(
      "⚠ base: a plugin exception withdrew 1 file(s); head: none of the 2 file(s) it found parsed.",
    )
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

// Windows has no filename that holds a backslash — the character is its path separator — so the
// fixture can only exist on POSIX. `@aburi/core`'s own suite pins the classification on every
// platform; these pin what the CLI does with a scan that found one.
const onPosix = it.skipIf(process.platform === "win32")

describe("aburi scan — a file no Document path can name", () => {
  onPosix("gates on it, because nothing else in the run is going to mention it", async () => {
    const warnings: string[] = []
    const report = await scanIn(["ok.stub", "weird\\name.stub"], warnings)

    expect(report.unrepresentableFiles).toEqual([
      { path: "weird\\name.stub", segment: "weird\\name.stub" },
    ])
    // Neither counted nor skipped, and that pairing is forced: the path a skip entry needs is
    // one the shared rule refuses, and a file counted while absent from the skip list breaks
    // integrity #21. The artifact is therefore silent about it, which is why the code is not.
    expect(report.totalFiles).toBe(1)
    expect(report.parsedFiles).toBe(1)
    expect(report.skipped).toEqual([])
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
  })

  onPosix("still writes the IR, so a reader gets the artifact and the code", async () => {
    // And the IR passes `assertIRIntegrity` on the way out, which is the census this file is
    // kept out of in order not to break.
    const report = await scanIn(["ok.stub", "weird\\name.stub"])
    expect(report.irPath).not.toBeNull()
  })

  onPosix("names the file and the segment at fault", async () => {
    const warnings: string[] = []
    await scanIn(["ok.stub", "v\\1-a.stub", "v\\1-b.stub"], warnings)
    const text = warnings.join("\n")
    expect(text).toContain("2 file(s) were left out of the IR and out of its counts")
    expect(text).toContain('    v\\1-a.stub: the segment "v\\1-a.stub" holds a backslash')
    expect(text).toContain('    v\\1-b.stub: the segment "v\\1-b.stub" holds a backslash')
  })

  onPosix("yields to a plugin exception, which says the run is broken rather than partial", async () => {
    // Both on one side. The exception is the reason that says something in the run is broken,
    // and it is the older of the two claims on this line, so the arm for this one sits behind
    // it rather than in front.
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["ok.stub", "boom.stub", "weird\\name.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("base: a plugin exception withdrew 1 file(s)")
    expect(warnings.join("\n")).not.toContain("base: 1 file(s) have names")
  })

  onPosix("yields to a coverage fault it did not cause", async () => {
    // An unnameable file leaves `totalFiles`, so it cannot push a scan below a floor or leave
    // files unparsed — leaving the denominator only raises the ratio. Where such a fault holds
    // it is its own cause, and naming this instead would send the reader to rename a file while
    // every file that *was* read failed to parse.
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["bad.stub", "weird\\name.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("base: none of the 1 file(s) it found parsed")
    expect(warnings.join("\n")).not.toContain("base: 1 file(s) have names")
  })

  onPosix("reddens a diff taken over it, in its own words", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["ok.stub", "weird\\name.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })

    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("base: 1 file(s) have names no Document path can spell")
  })
})
