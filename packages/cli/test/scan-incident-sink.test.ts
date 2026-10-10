import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runCli, runScan, type ScanOptions } from "../src"
import { MemStream, runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("scan-incident-sink")

const REFUSAL = "parse reported a non-recoverable error at 12:4 — unterminated string"
const PARSE_FAILED_ADVICE =
  "the language plugin refused the source. Deterministic: fix the file, or the plugin."
const EXTRACTION_FAILED_ADVICE =
  "a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean."

const FOUR_KINDS_OF_FILE = ["bad.stub", "boom.stub", "warn.stub", "ok.stub"]

const FOUR_KINDS_REPORTED = [
  "⚠ 1 file(s) had recoverable parse errors.",
  "    warn.stub: 2:1 — stray token",
  "⚠ 1 file(s) could not be parsed and were left out of the IR.",
  "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1",
  `⚠ parse-failed (1) — ${PARSE_FAILED_ADVICE}`,
  `    bad.stub: ${REFUSAL}`,
  `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
  "    boom.stub: plugin exploded",
]

function scanStubs(incidents?: ScanOptions["incidents"]) {
  return runScan({
    cwd: workspace.root,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
    ...(incidents === undefined ? {} : { incidents }),
  })
}

async function incidentsOf(files: readonly string[], label?: string): Promise<readonly string[]> {
  await writeStubWorkspace(workspace.root, files)
  const log = recordingLogger()
  await scanStubs(label === undefined ? { warn: log.warn } : { warn: log.warn, label })
  return log.warnings
}

describe("runScan — the incident report goes to the caller's sink", () => {
  it("emits the lines the scan command prints, in the same order", async () => {
    expect(await incidentsOf(FOUR_KINDS_OF_FILE)).toEqual(FOUR_KINDS_REPORTED)
  })

  it("returns the same report when no sink was given", async () => {
    await writeStubWorkspace(workspace.root, ["bad.stub", "boom.stub", "ok.stub"])
    const report = await scanStubs()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.skipped).toHaveLength(2)
  })

  it("cannot let a broken sink change the exit code", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    const report = await scanStubs({
      warn: () => {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
      },
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.extractionFailures).toHaveLength(1)
  })

  it("summarizes a file that reported more than one error, and says where recovery began", async () => {
    expect(await incidentsOf(["noisy.stub", "ok.stub"])).toEqual([
      "⚠ 1 file(s) had recoverable parse errors.",
      "    noisy.stub: 2 errors, first at 2:1 — stray token",
    ])
  })

  it("labels every line it owns, and leaves the per-file listing unlabelled", async () => {
    expect(await incidentsOf(["boom.stub", "ok.stub"], 'base ref "main"')).toEqual([
      '⚠ base ref "main": 1 file(s) contributed no Symbols: extraction-failed=1',
      `⚠ base ref "main": extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      "    boom.stub: plugin exploded",
    ])
  })

  it("reports a file withdrawn for a duplicate Symbol id on the lines a throw reaches", async () => {
    expect(await incidentsOf(["ok.stub", "twin.stub"])).toEqual([
      "⚠ 1 file(s) contributed no Symbols: extraction-failed=1",
      `⚠ extraction-failed (1) — ${EXTRACTION_FAILED_ADVICE}`,
      '    twin.stub: two Symbols share the id "stub:twin.stub#twin_stub" (lines 1 and 7); ' +
        "the language plugin gave two declarations one qualified name, and nothing it " +
        "reported separates them",
    ])
  })

  it("gates on a duplicate Symbol id and still writes the IR the surviving file produced", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "twin.stub"])
    const report = await scanStubs()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBe(1)
    expect(report.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["twin.stub", "duplicate-symbol-id"],
    ])
  })
})

describe("aburi scan — the incident report on stderr", () => {
  it("puts the whole report on stderr", async () => {
    await writeStubWorkspace(workspace.root, FOUR_KINDS_OF_FILE)
    const { code, stderr } = await runCliIn(workspace.root, [
      "scan",
      "--output-dir",
      resolve(workspace.root, "out"),
      "--format",
      "json",
    ])
    expect(code).toBe(EXIT.GATE)
    expect(stderr).toBe(FOUR_KINDS_REPORTED.map((line) => `${line}\n`).join(""))
  })

  it("puts the warnings above the summary they qualify, not below it", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    const merged = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(workspace.root, "out"), "--format", "json"],
      stdout: merged,
      stderr: merged,
      env: {},
      cwd: workspace.root,
    })
    const lines = merged.text().trimEnd().split("\n")
    expect(lines[0]).toContain("contributed no Symbols")
    expect(lines.findIndex((l) => l.includes("kept ·"))).toBeGreaterThan(
      lines.findIndex((l) => l.includes("a plugin threw")),
    )
  })
})
