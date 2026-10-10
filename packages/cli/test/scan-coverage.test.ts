import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { UnrepresentableFile } from "@aburi/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli, runDiff, runExplain, runScan, type ScanReport } from "../src"
import { incidentLinesFrom, MemStream, scanReportWith } from "./fixtures"
import { gitWith, populate } from "./stub-language"

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
    await scanIn(["bad.stub", "boom-a.stub", "boom-b.stub"], warnings)
    expect(warnings.join("\n")).toContain("3 file(s) discovered, 0 parsed — 2 as extraction-failed")
  })

  it("breaks a tie on the reason enum rather than on the order of the walk", async () => {
    const warnings: string[] = []
    await scanIn(["boom.stub", "zz-bad.stub"], warnings)
    expect(warnings.join("\n")).toContain("2 file(s) discovered, 0 parsed — 1 as parse-failed")
  })

  it("still writes the IR, so a reader gets the artifact and the code", async () => {
    const report = await scanIn(["bad.stub"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
  })

  it("gates when discovery found nothing to scan at all", async () => {
    const warnings: string[] = []
    const report = await scanIn([], warnings)
    expect(report.totalFiles).toBe(0)
    expect(report.exitCode).toBe(EXIT.GATE)
    const line = warnings.join("\n")
    expect(line).toContain("No file was discovered")
    expect(line).toContain("ignore")
    expect(line).toContain("components[].roots")
    expect(line).not.toContain("0 parsed")
  })

  it("stays green for a scan that lost most of the workspace but not all of it", async () => {
    const warnings: string[] = []
    const report = await scanIn(["bad.stub", "boom.stub", "ok.stub"], warnings)
    expect(report.parsedFiles).toBe(1)
    expect(report.totalFiles).toBe(3)
    expect(report.coverageFault).toBeNull()
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
    await populate(scratch, ["ok.stub"])
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
        $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
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
    const report = await scanWithFloor(["bad.stub", "ok.stub"], 0.5)
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("counts every reason a file went missing, not the machine-dependent one only", async () => {
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

function unspellable(fsPath: string, unnameablePrefix: string): UnrepresentableFile {
  return { fsPath, reason: "unspellable-name", unnameablePrefix }
}

describe("reportScanIncidents — the fault and the code cannot disagree", () => {
  it("puts the coverage line first, above the census that explains it", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
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

  it("names what has to be renamed, once, however many files sit under it", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        totalFiles: 3,
        parsedFiles: 3,
        unrepresentableFiles: [
          unspellable("src/v\\1/other.stub", "src/v\\1"),
          unspellable("src/v\\1/util.stub", "src/v\\1"),
          unspellable("odd\\name.stub", "odd\\name.stub"),
        ],
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines[0]).toContain("3 file(s) were left out of the IR and out of its counts")
    expect(lines[0]).toContain("under 2 name(s) with no spelling here")
    expect(lines[1]).toBe("    odd\\name.stub")
    expect(lines[2]).toBe("    src/v\\1 — a directory, and the 2 file(s) under it")
    expect(lines).toHaveLength(3)
  })

  it("puts the one record nothing else holds above the census that is recoverable", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        totalFiles: 1,
        parsedFiles: 0,
        skipped: [{ path: "src/a.ts", reason: "over-size" as const, detail: "big" }],
        unrepresentableFiles: [unspellable("odd\\name.ts", "odd\\name.ts")],
        exitCode: EXIT.GATE,
      }),
      null,
    )
    const unnameableAt = lines.findIndex((l) => l.includes("out of its counts"))
    const censusAt = lines.findIndex((l) => l.includes("contributed no Symbols"))
    expect(unnameableAt).toBeGreaterThanOrEqual(0)
    expect(censusAt).toBeGreaterThan(unnameableAt)
  })

  it("tells the reader the ignore spelling that actually matches", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        unrepresentableFiles: [unspellable("odd\\name.stub", "odd\\name.stub")],
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines[0]).toContain("write its backslash twice")
    expect(lines[0]).toContain("does not match itself")
  })

  it("does not cap the list, because nothing else holds a copy of it", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
        unrepresentableFiles: Array.from({ length: 12 }, (_, i) =>
          unspellable(`f${i}\\x.stub`, `f${i}\\x.stub`),
        ),
        exitCode: EXIT.GATE,
      }),
      null,
    )
    expect(lines).toHaveLength(13)
    expect(lines.join("\n")).not.toContain("more")
  })

  it("never prints a percentage as being below itself", () => {
    const lines = incidentLinesFrom(
      scanReportWith({
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
      const lines = incidentLinesFrom(
        scanReportWith({
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
    const lines = incidentLinesFrom(
      scanReportWith({
        coverageFault: { kind: "nothing-discovered" },
        exitCode: EXIT.GATE,
      }),
      'base ref "main"',
    )
    expect(lines[0]).toContain('⚠ base ref "main": No file was discovered')
  })

  it("says nothing when the scan read the workspace", () => {
    expect(incidentLinesFrom(scanReportWith({ totalFiles: 3, parsedFiles: 3 }), null)).toEqual([])
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
    expect(warnings.join("\n")).toContain("base: extraction withdrew 1 file(s)")
  })

  it("says each faulted side's own cause rather than one side's about both", async () => {
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
      "⚠ base: extraction withdrew 1 file(s); head: none of the 2 file(s) it found parsed.",
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

const onPosix = it.skipIf(process.platform === "win32")

describe("aburi scan — a file no Document path can name", () => {
  onPosix("gates on it, because nothing else in the run is going to mention it", async () => {
    const warnings: string[] = []
    const report = await scanIn(["ok.stub", "weird\\name.stub"], warnings)

    expect(report.unrepresentableFiles).toEqual([
      unspellable("weird\\name.stub", "weird\\name.stub"),
    ])
    expect(report.totalFiles).toBe(1)
    expect(report.parsedFiles).toBe(1)
    expect(report.skipped).toEqual([])
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
  })

  onPosix("adds them back to the stdout summary, which counts what it could name", async () => {
    await populate(scratch, ["ok.stub", "weird\\name.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out")],
      cwd: scratch,
      stdout,
      stderr,
    })

    expect(code).toBe(EXIT.GATE)
    expect(stdout.text()).toContain("1 files · 1 unnameable")
  })

  onPosix("still writes the IR, so a reader gets the artifact and the code", async () => {
    const report = await scanIn(["ok.stub", "weird\\name.stub"])
    expect(report.irPath).not.toBeNull()
  })

  onPosix("names the file and the segment at fault", async () => {
    const warnings: string[] = []
    await scanIn(["ok.stub", "v\\1-a.stub", "v\\1-b.stub"], warnings)
    const text = warnings.join("\n")
    expect(text).toContain("2 file(s) were left out of the IR and out of its counts")
    expect(text).toContain("    v\\1-a.stub")
    expect(text).toContain("    v\\1-b.stub")
  })

  onPosix(
    "yields to a plugin exception, which says the run is broken rather than partial",
    async () => {
      await populate(scratch, ["ok.stub"])
      const warnings: string[] = []
      await runDiff({
        cwd: scratch,
        refSpec: "main..HEAD",
        git: gitWith(["ok.stub", "boom.stub", "weird\\name.stub"]),
        outputDir: resolve(scratch, "out"),
        warn: (m) => warnings.push(m),
      })
      expect(warnings.join("\n")).toContain("base: extraction withdrew 1 file(s)")
      expect(warnings.join("\n")).not.toContain("base: 1 file(s) have names")
    },
  )

  onPosix("yields to a coverage fault it did not cause", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["bad.stub", "weird\\name.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain(
      "base: none of the 1 file(s) it found parsed (and 1 more have names no Document path can spell)",
    )
  })

  onPosix("outranks the fault it caused, when it took the whole candidate set", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["weird\\name.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings.join("\n")).toContain("base: 1 file(s) have names no Document path can spell")
    expect(warnings.join("\n")).not.toContain("base: it discovered no file to read")
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
const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("aburi scan — two spellings of one name", () => {
  onCollidingFs("reports both instead of ending the scan on a duplicate id", async () => {
    const warnings: string[] = []
    await populate(scratch, ["ok.stub"])
    await writeFile(resolve(scratch, "caf\u0065\u0301.stub"), "a", "utf8")
    await writeFile(resolve(scratch, "caf\u00e9.stub"), "b", "utf8")

    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })

    expect(report.unrepresentableFiles).toEqual([
      {
        fsPath: "caf\u0065\u0301.stub",
        reason: "colliding-spelling",
        documentPath: "caf\u00e9.stub",
      },
      { fsPath: "caf\u00e9.stub", reason: "colliding-spelling", documentPath: "caf\u00e9.stub" },
    ])
    expect(report.totalFiles).toBe(1)
    expect(report.parsedFiles).toBe(1)
    expect(report.skipped).toEqual([])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
  })

  onCollidingFs("names both by codepoint, since a terminal prints them identically", async () => {
    const warnings: string[] = []
    await populate(scratch, ["ok.stub"])
    await writeFile(resolve(scratch, "caf\u0065\u0301.stub"), "a", "utf8")
    await writeFile(resolve(scratch, "caf\u00e9.stub"), "b", "utf8")

    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })

    const text = warnings.join("\n")
    expect(text).toContain("path(s) more than one name claims")
    expect(text).toContain("U+0065 U+0301")
    expect(text).toContain("U+00E9")
    expect(text).toContain("excludes whichever claimant is spelled that way")
    expect(text).toContain("a wildcard over it excludes them all")
  })

  onCollidingFs("catches a collision between a skipped candidate and a parsed one", async () => {
    const warnings: string[] = []
    await populate(scratch, ["ok.stub"])
    await writeFile(resolve(scratch, "b\u0061\u0301d.stub"), "a", "utf8")
    await writeFile(resolve(scratch, "b\u00e1d.stub"), "b", "utf8")

    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })

    expect(report.unrepresentableFiles).toHaveLength(2)
    expect(report.skipped).toEqual([])
    expect(report.totalFiles).toBe(1)
  })
})
describe("aburi scan — a name the filesystem and the Document spell differently", () => {
  it("reads it, parses it, and records the normalized spelling", async () => {
    const warnings: string[] = []
    await populate(scratch, ["ok.stub"])
    await writeFile(resolve(scratch, "caf\u0065\u0301.stub"), "hello", "utf8")

    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      incidents: { warn: (m: string) => warnings.push(m) },
    })

    expect(report.skipped).toEqual([])
    expect(report.totalFiles).toBe(2)
    expect(report.parsedFiles).toBe(2)
    expect(report.exitCode).toBe(EXIT.SUCCESS)

    const ir = JSON.parse(await readFile(resolve(scratch, "out/aburi.ir.json"), "utf8")) as {
      symbols: { source: { file: string } }[]
    }
    expect(ir.symbols.map((s) => s.source.file).sort()).toEqual(["caf\u00e9.stub", "ok.stub"])
  })
})
