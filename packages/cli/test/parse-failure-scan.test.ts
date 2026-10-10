import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT, runScan } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("parse-failure")

beforeEach(async () => {
  await writeStubWorkspace(workspace.root, ["bad.stub", "notree.stub", "warn.stub", "ok.stub"])
})

describe("aburi scan — files the language plugin refused", () => {
  it("names them in skipped and counts them apart from the file that kept its warnings, exiting 0", async () => {
    const report = await runScan({
      cwd: workspace.root,
      outputDir: resolve(workspace.root, "out"),
      format: "json",
    })

    expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "parse-failed"],
      ["notree.stub", "parse-failed"],
    ])
    expect(report).toMatchObject({
      parseFailureCount: 2,
      parseErrorCount: 1,
      extractionFailures: [],
      keptSymbols: 2,
      totalFiles: 4,
      exitCode: EXIT.SUCCESS,
    })
  })

  it("gives the withdrawals their own stderr line, apart from the recoverable count", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr).toContain("1 file(s) had recoverable parse errors.")
    expect(stderr).toContain("2 file(s) could not be parsed and were left out of the IR.")
  })
})
