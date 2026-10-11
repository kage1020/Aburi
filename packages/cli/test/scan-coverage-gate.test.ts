import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runScan, type ScanReport } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("scan-coverage")

async function scanStubs(
  files: readonly string[],
  config: Record<string, unknown> = {},
): Promise<{ report: ScanReport; said: string }> {
  await writeStubWorkspace(workspace.root, files, config)
  const log = recordingLogger()
  const report = await runScan({
    cwd: workspace.root,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
    incidents: { warn: log.warn },
  })
  return { report, said: log.warnings.join("\n") }
}

describe("aburi scan — a workspace it could not read", () => {
  it.each([
    [["bad.stub"], "1 file(s) discovered, 0 parsed — 1 as parse-failed"],
    [
      ["bad.stub", "boom-a.stub", "boom-b.stub"],
      "3 file(s) discovered, 0 parsed — 2 as extraction-failed",
    ],
    [["boom.stub", "zz-bad.stub"], "2 file(s) discovered, 0 parsed — 1 as parse-failed"],
  ])("gates on %j, naming the reason that took the most files", async (files, line) => {
    const { report, said } = await scanStubs(files)
    expect(report.parsedFiles).toBe(0)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
    expect(said).toContain(line)
  })

  it("gates when discovery found nothing to scan at all, and says where to look", async () => {
    const { report, said } = await scanStubs([])
    expect(report.totalFiles).toBe(0)
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain("No file was discovered")
    expect(said).toContain("ignore")
    expect(said).toContain("components[].roots")
    expect(said).not.toContain("0 parsed")
  })

  it("raises no coverage fault for a scan that parsed something", async () => {
    const { report, said } = await scanStubs(["bad.stub", "boom.stub", "ok.stub"])
    expect(report.parsedFiles).toBe(1)
    expect(report.totalFiles).toBe(3)
    expect(report.coverageFault).toBeNull()
    expect(said).not.toContain("discovered, 0 parsed")
  })

  it("stays green, and silent, for a scan that read everything", async () => {
    const { report, said } = await scanStubs(["ok.stub"])
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(said).toBe("")
  })

  it("exits 3 from the command, with the line on stderr", async () => {
    await writeStubWorkspace(workspace.root, ["bad.stub"])
    const { code, stderr } = await runCliIn(workspace.root, [
      "scan",
      "--output-dir",
      resolve(workspace.root, "out"),
      "--format",
      "json",
    ])
    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain("1 file(s) discovered, 0 parsed")
  })
})

describe("config.minParsedFileRatio — the floor a workspace opts into", () => {
  it.each([
    ["never set", undefined],
    ["met exactly", 0.5],
  ])("does not gate on a floor %s", async (_, floor) => {
    const { report } = await scanStubs(
      ["bad.stub", "ok.stub"],
      floor === undefined ? {} : { minParsedFileRatio: floor },
    )
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })

  it("gates when coverage falls below it, naming both counts and the floor", async () => {
    const { report, said } = await scanStubs(["bad.stub", "ok.stub"], { minParsedFileRatio: 0.9 })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain("1 of 2 file(s) parsed (50%), below the minParsedFileRatio floor of 90%")
  })

  it("counts every reason a file went missing, not the machine-dependent one only", async () => {
    const { report, said } = await scanStubs(["boom.stub", "ok.stub"], { minParsedFileRatio: 1 })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain("1 of 2 file(s) parsed (50%)")
  })

  it("leaves an empty workspace to the unconditional gate rather than to a division", async () => {
    const { report, said } = await scanStubs([], { minParsedFileRatio: 0.9 })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain("No file was discovered")
    expect(said).not.toContain("minParsedFileRatio")
  })

  it.each([
    0, 1.5,
  ])("refuses %d, a floor nothing can fall below or nothing can reach", async (floor) => {
    await expect(scanStubs(["ok.stub"], { minParsedFileRatio: floor })).rejects.toThrow(
      /minParsedFileRatio/,
    )
  })
})
