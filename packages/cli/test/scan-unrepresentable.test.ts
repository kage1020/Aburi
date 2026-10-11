import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { UnrepresentableFile } from "@aburi/core"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, IR_JSON_FILENAME, runExplain, runScan, type ScanReport } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("scan-unrepresentable")

async function scanStubs(files: readonly string[]): Promise<{ report: ScanReport; said: string }> {
  await writeStubWorkspace(workspace.root, files)
  const log = recordingLogger()
  const report = await runScan({
    cwd: workspace.root,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
    incidents: { warn: log.warn },
  })
  return { report, said: log.warnings.join("\n") }
}

function unspellable(fsPath: string): UnrepresentableFile {
  return { fsPath, reason: "unspellable-name", unnameablePrefix: fsPath }
}

describe("aburi scan — a name no Symbol id can hold", () => {
  it("lists it, keeps the rest, and lets explain answer out of it", async () => {
    const { report, said } = await scanStubs(["ok.stub", "src/od#d.stub"])

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.parsedFiles).toBe(1)
    expect(report.keptSymbols).toBe(1)
    expect(said).toContain("1 file(s) contributed no Symbols: unroutable=1")
    expect(said).toContain(
      '    src/od#d.stub: its path segment "od#d.stub" contains "#", which a Symbol id is split on',
    )
    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "src/od#d.stub",
      irPath: resolve(workspace.root, "out", IR_JSON_FILENAME),
    })
    expect(outcome).toMatchObject({ kind: "unknown", exitCode: EXIT.GATE })
  })

  it("trips the coverage gate when every file it found was one", async () => {
    const { report, said } = await scanStubs(["od#d.stub"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(said).toContain("1 file(s) discovered, 0 parsed — 1 as unroutable")
  })
})

const onPosix = it.skipIf(process.platform === "win32")

describe("aburi scan — a file no Document path can name", () => {
  onPosix("gates on it, leaves it out of the counts, and still writes the IR", async () => {
    const { report } = await scanStubs(["ok.stub", "weird\\name.stub"])

    expect(report.unrepresentableFiles).toEqual([unspellable("weird\\name.stub")])
    expect(report.totalFiles).toBe(1)
    expect(report.parsedFiles).toBe(1)
    expect(report.skipped).toEqual([])
    expect(report.coverageFault).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
  })

  onPosix("adds them back to the stdout summary, which counts what it could name", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub", "weird\\name.stub"])
    const { code, stdout } = await runCliIn(workspace.root, [
      "scan",
      "--output-dir",
      resolve(workspace.root, "out"),
    ])
    expect(code).toBe(EXIT.GATE)
    expect(stdout).toContain("1 files · 1 unnameable")
  })

  onPosix("names each file at fault", async () => {
    const { said } = await scanStubs(["ok.stub", "v\\1-a.stub", "v\\1-b.stub"])
    expect(said).toContain("2 file(s) were left out of the IR and out of its counts")
    expect(said).toContain("    v\\1-a.stub")
    expect(said).toContain("    v\\1-b.stub")
  })
})

const onCollidingFs = it.skipIf(process.platform === "darwin")

describe("aburi scan — two spellings of one name", () => {
  onCollidingFs(
    "reports both by codepoint instead of ending the scan on a duplicate id",
    async () => {
      await writeFileAt(workspace.root, "café.stub", "a")
      await writeFileAt(workspace.root, "café.stub", "b")
      const { report, said } = await scanStubs(["ok.stub"])

      expect(report.unrepresentableFiles).toEqual([
        { fsPath: "café.stub", reason: "colliding-spelling", documentPath: "café.stub" },
        { fsPath: "café.stub", reason: "colliding-spelling", documentPath: "café.stub" },
      ])
      expect(report.totalFiles).toBe(1)
      expect(report.parsedFiles).toBe(1)
      expect(report.skipped).toEqual([])
      expect(report.exitCode).toBe(EXIT.GATE)
      expect(report.irPath).not.toBeNull()
      expect(said).toContain("path(s) more than one name claims")
      expect(said).toContain("U+0065 U+0301")
      expect(said).toContain("U+00E9")
      expect(said).toContain("excludes whichever claimant is spelled that way")
      expect(said).toContain("a wildcard over it excludes them all")
    },
  )

  onCollidingFs("catches a collision between a skipped candidate and a parsed one", async () => {
    await writeFileAt(workspace.root, "bád.stub", "a")
    await writeFileAt(workspace.root, "bád.stub", "b")
    const { report } = await scanStubs(["ok.stub"])

    expect(report.unrepresentableFiles).toHaveLength(2)
    expect(report.skipped).toEqual([])
    expect(report.totalFiles).toBe(1)
  })
})

describe("aburi scan — a name the filesystem and the Document spell differently", () => {
  it("reads it, parses it, and records the normalized spelling", async () => {
    await writeFileAt(workspace.root, "café.stub", "hello")
    const { report } = await scanStubs(["ok.stub"])

    expect(report.skipped).toEqual([])
    expect(report.totalFiles).toBe(2)
    expect(report.parsedFiles).toBe(2)
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    const ir = JSON.parse(
      await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
    ) as { symbols: { source: { file: string } }[] }
    expect(ir.symbols.map((s) => s.source.file).sort()).toEqual(["café.stub", "ok.stub"])
  })
})
