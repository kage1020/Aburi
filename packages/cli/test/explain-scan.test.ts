import { resolve } from "node:path"
import { recordingLogger, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runExplain, runScan } from "../src"
import { symbolFor, writeScannedWorkspace } from "./ir-documents"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"
import { TYPESCRIPT, writeConfig } from "./workspace"

const workspace = useScratchWorkspace("explain-scan")

async function explainAfterScan(files: readonly string[], argument: string) {
  await writeStubWorkspace(workspace.root, files)
  const log = recordingLogger()
  const outcome = await runExplain({ cwd: workspace.root, argument, warn: log.warn })
  return { outcome, said: log.warnings.join("\n") }
}

describe("aburi explain with no IR on disk — the scan it runs", () => {
  it("answers unknown for a file its own green scan withdrew", async () => {
    const { outcome } = await explainAfterScan(["bad.stub", "ok.stub"], "stub:bad.stub#bad_stub")
    expect(outcome).toMatchObject({
      kind: "unknown",
      exitCode: EXIT.GATE,
      skipped: { path: "bad.stub", reason: "parse-failed" },
    })
  })

  it("answers the file that scan did read, which is what keeps the scan green", async () => {
    const { outcome } = await explainAfterScan(["bad.stub", "ok.stub"], "stub:ok.stub#ok_stub")
    expect(outcome).toMatchObject({ kind: "single", exitCode: EXIT.SUCCESS })
  })

  it.each([
    ["a found answer", ["boom.stub", "ok.stub"], "ok_stub", "single", "plugin threw"],
    [
      "a miss the fault may explain",
      ["boom.stub", "ok.stub"],
      "boom_stub",
      "not-found",
      "plugin threw",
    ],
    [
      "a candidate list the fault may have shortened",
      ["boom.stub", "ok.stub", "ok2.stub"],
      "ok",
      "ambiguous",
      "plugin threw",
    ],
    [
      "a miss in a workspace the scan read nothing of",
      ["bad.stub"],
      "anything",
      "not-found",
      "1 file(s) discovered, 0 parsed",
    ],
  ])("exits 3 on %s when the scan faulted, and reports the fault", async (_, files, argument, kind, incident) => {
    const { outcome, said } = await explainAfterScan(files, argument)
    expect(outcome).toMatchObject({ kind, exitCode: EXIT.GATE })
    expect(said).toContain(incident)
  })

  it("prints the answer and the scan's incidents from the command", async () => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    const { code, stdout, stderr } = await runCliIn(workspace.root, ["explain", "ok_stub"])
    expect(code).toBe(EXIT.GATE)
    expect(stdout).toContain("ok_stub")
    expect(stderr).toContain("extraction-failed (1)")
    expect(stderr).toContain("boom.stub: plugin exploded")
  })

  it("names the withdrawal behind a No matches answer", async () => {
    await writeStubWorkspace(workspace.root, ["bad.stub", "ok.stub"])
    const { code, stderr } = await runCliIn(workspace.root, ["explain", "bad_stub"])
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr).toContain("1 file(s) could not be parsed and were left out of the IR.")
    expect(stderr).toContain('No matches for "bad_stub".')
  })
})

describe("aburi explain with an IR on disk", () => {
  it.each([
    ["the one scan wrote", "out", []],
    ["named with --ir", "pinned", ["--ir", "pinned/aburi.ir.json"]],
  ])("reports none of the incidents of the scan that wrote %s", async (_, outputDir, flags) => {
    await writeStubWorkspace(workspace.root, ["boom.stub", "ok.stub"])
    await runScan({
      cwd: workspace.root,
      outputDir: resolve(workspace.root, outputDir),
      format: "json",
    })

    const { code, stderr } = await runCliIn(workspace.root, ["explain", "ok_stub", ...flags])

    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr).toBe("")
  })
})

describe("aburi explain --debug-resolution", () => {
  it.each([
    [
      { noRescan: true },
      /--debug-resolution needs a fresh scan .* cannot be combined with --no-rescan/,
    ],
    [
      { irPath: "out/aburi.ir.json" },
      /--debug-resolution needs a fresh scan .* cannot read an existing --ir file/,
    ],
  ])("refuses %j, which would answer from a document without the per-call buckets", async (options, refusal) => {
    await writeScannedWorkspace(workspace.root, { symbols: [] })
    await expect(
      runExplain({ cwd: workspace.root, argument: "x", debugResolution: true, ...options }),
    ).rejects.toThrow(refusal)
  })

  it("rescans rather than answering from the IR sitting on disk", async () => {
    await writeScannedWorkspace(workspace.root, { symbols: [symbolFor("ts:src/a.ts#getUser")] })
    await writeConfig(workspace.root, TYPESCRIPT)

    const outcome = await runExplain({
      cwd: workspace.root,
      argument: "ts:src/a.ts#getUser",
      debugResolution: true,
    })

    expect(outcome.kind).toBe("not-found")
  })
})
