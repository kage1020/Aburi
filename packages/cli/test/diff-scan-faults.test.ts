import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, formatFailOnMessage, IR_JSON_FILENAME, runDiff, runScan } from "../src"
import { git } from "./git"
import { writeStubRepository, writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("diff-scan-faults")

async function diffRevisions(
  files: { base: readonly string[]; head: readonly string[] },
  options: { refSpec?: string; failOn?: string } = {},
) {
  await writeStubRepository(workspace.root, files)
  const log = recordingLogger()
  const report = await runDiff({
    cwd: workspace.root,
    refSpec: options.refSpec ?? "main..HEAD",
    outputDir: resolve(workspace.root, "out"),
    warn: log.warn,
    ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
  })
  return { report, warnings: log.warnings, said: log.warnings.join("\n") }
}

describe("aburi diff — the two scans it ran", () => {
  it("labels each side, and never calls the head by the ref spec's head label", async () => {
    await writeStubRepository(workspace.root, {
      base: ["bad.stub", "ok.stub"],
      head: ["warn.stub", "ok.stub"],
    })
    await git(["tag", "v1.1.0"], workspace.root)
    const log = recordingLogger()

    await runDiff({
      cwd: workspace.root,
      refSpec: "main..v1.1.0",
      outputDir: resolve(workspace.root, "out"),
      warn: log.warn,
    })

    expect(log.warnings).toContain(
      '⚠ base ref "main": 1 file(s) could not be parsed and were left out of the IR.',
    )
    expect(log.warnings).toContain("⚠ head (working tree): 1 file(s) had recoverable parse errors.")
    expect(log.warnings).toContain("    warn.stub: 2:1 — stray token")
    expect(log.warnings.join("\n")).not.toContain("v1.1.0")
  })

  it("gates on a plugin fault at either side and names which, with no clause triggered", async () => {
    const { report, warnings } = await diffRevisions({
      base: ["boom.stub", "ok.stub"],
      head: ["ok.stub"],
    })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings).toContain(
      "⚠ base: extraction withdrew 1 file(s). This run exits 3 even though " +
        "the diff was written. Fix it, or the comparison is against a workspace one side could not read.",
    )
  })

  it("keeps the clause alongside the fault, so neither hides the other", async () => {
    const { report, warnings } = await diffRevisions(
      { base: ["boom.stub", "ok.stub", "extra.stub"], head: ["ok.stub"] },
      { failOn: "removed" },
    )
    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings).toContain(
      '⚠ base ref "main": extraction-failed (1) — a plugin threw while extracting, or its Symbols could not enter the Document. This is the reason the run does not exit clean.',
    )
    expect(report.triggered).not.toBeNull()
    if (report.triggered !== null)
      expect(formatFailOnMessage(report.triggered)).toContain("removed")
  })

  it("earns the fault clause for a duplicate Symbol id without claiming an exception", async () => {
    const { report, said } = await diffRevisions({
      base: ["ok.stub"],
      head: ["ok.stub", "twin.stub"],
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.faultedScans).toEqual(["head"])
    expect(said).toContain("head: extraction withdrew 1 file(s)")
    expect(said).not.toContain("exception")
  })

  it("says the counts can be wrong when a file parsed with recoverable errors", async () => {
    const { warnings } = await diffRevisions({
      base: ["warn.stub", "ok.stub"],
      head: ["warn.stub", "ok.stub"],
    })
    expect(warnings).toEqual([
      '⚠ base ref "main": 1 file(s) had recoverable parse errors.',
      "    warn.stub: 2:1 — stray token",
      "⚠ head (working tree): 1 file(s) had recoverable parse errors.",
      "    warn.stub: 2:1 — stray token",
      expect.stringContaining("Their Symbol sets can be short, which moves added / removed"),
    ])
  })

  it("keeps each scan's report and the skipped-by-both line when a file is lost on both sides", async () => {
    const { warnings, said } = await diffRevisions({
      base: ["bad.stub", "ok.stub"],
      head: ["bad.stub", "ok.stub"],
    })
    expect(warnings.filter((m) => m.includes("contributed no Symbols"))).toHaveLength(2)
    expect(warnings.filter((m) => m.includes("skipped by both scans"))).toHaveLength(1)
    expect(said).not.toContain("recoverable parse errors")
    expect(said).not.toContain("exits 3")
  })
})

describe("aburi diff — why each faulted scan did not exit clean", () => {
  it.each([
    [
      "names coverage as the cause",
      ["bad.stub"],
      ["ok.stub"],
      "⚠ base: none of the 1 file(s) it found parsed.",
    ],
    [
      "says each faulted side's own cause",
      ["boom.stub", "ok.stub"],
      ["bad.stub", "zz-bad.stub"],
      "⚠ base: extraction withdrew 1 file(s); head: none of the 2 file(s) it found parsed.",
    ],
    [
      "names both sides when both faulted the same way",
      ["boom.stub", "ok.stub"],
      ["boom.stub", "ok.stub"],
      "⚠ base: extraction withdrew 1 file(s); head: extraction withdrew 1 file(s).",
    ],
  ])("%s", async (_, base, head, line) => {
    const { report, said } = await diffRevisions({ base, head })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain(line)
    expect(said).not.toContain("did not exit clean")
  })

  it.skipIf(process.platform === "win32").each([
    [
      "yields to a plugin exception",
      ["ok.stub", "boom.stub", "weird\\name.stub"],
      "base: extraction withdrew 1 file(s).",
      "base: 1 file(s) have names",
    ],
    [
      "trails a coverage fault it did not cause",
      ["bad.stub", "weird\\name.stub"],
      "base: none of the 1 file(s) it found parsed (and 1 more have names no Document path can spell).",
      "",
    ],
    [
      "outranks the coverage fault it caused by taking the whole candidate set",
      ["weird\\name.stub"],
      "base: 1 file(s) have names no Document path can spell.",
      "discovered no file to read",
    ],
    [
      "reddens the diff on its own",
      ["ok.stub", "weird\\name.stub"],
      "base: 1 file(s) have names no Document path can spell.",
      "did not exit clean",
    ],
  ])("a name no Document path can spell %s", async (_, base, line, absent) => {
    const { report, said } = await diffRevisions({ base, head: ["ok.stub"] })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain(line)
    if (absent !== "") expect(said).not.toContain(absent)
  })
})

describe("aburi diff --base/--head — faults the documents remember", () => {
  async function scanInto(directory: string, files: readonly string[]): Promise<string> {
    await writeStubWorkspace(directory, files)
    const outputDir = resolve(directory, "out")
    await runScan({ cwd: directory, outputDir, format: "json" })
    return resolve(outputDir, IR_JSON_FILENAME)
  }

  async function diffFiles(base: string, head: string) {
    const log = recordingLogger()
    const report = await runDiff({
      cwd: workspace.root,
      base,
      head,
      outputDir: resolve(workspace.root, "diff-out"),
      warn: log.warn,
    })
    return { report, said: log.warnings.join("\n") }
  }

  it("names a withdrawal on both sides without gating on someone else's run", async () => {
    const ir = await scanInto(workspace.root, ["boom.stub", "ok.stub"])
    const { report, said } = await diffFiles(ir, ir)
    expect(report.faultedScans).toBeNull()
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(said).toContain("base IR records 1 file(s) withdrawn during extraction: boom.stub")
    expect(said).toContain("head IR records 1 file(s) withdrawn during extraction: boom.stub")
    expect(said).not.toContain("recoverable parse errors")
  })

  it("attributes a recorded withdrawal to the document that holds it", async () => {
    const base = await scanInto(resolve(workspace.root, "base"), ["boom.stub", "ok.stub"])
    const head = await scanInto(resolve(workspace.root, "head"), ["ok.stub"])
    const { said } = await diffFiles(base, head)
    expect(said).toContain("base IR records 1 file(s) withdrawn during extraction")
    expect(said).not.toContain("head IR records")
  })

  it("stays quiet about documents no plugin threw on", async () => {
    const ir = await scanInto(workspace.root, ["bad.stub", "ok.stub"])
    const { report, said } = await diffFiles(ir, ir)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(said).not.toContain("withdrawn during extraction")
  })
})
