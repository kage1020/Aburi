import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runScan, VOCAB_DISCOVERED_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"

const workspace = useScratchWorkspace("strict-vocab")

function scanWith(...flags: string[]) {
  return runCliIn(workspace.root, ["scan", "--format", "json", ...flags])
}

async function readRecord(): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(workspace.root, "out", VOCAB_DISCOVERED_FILENAME), "utf8"),
  )
}

const ODD_TWICE = {
  items: [
    {
      kind: "extKind",
      value: "stub:odd:thing",
      firstSeenBy: "lang-stub",
      alsoSeenBy: [],
      occurrences: 2,
      samples: [
        { file: "odd-a.stub", symbol: "stub:odd-a.stub#odd_a_stub" },
        { file: "odd-b.stub", symbol: "stub:odd-b.stub#odd_b_stub" },
      ],
    },
  ],
}

describe("aburi scan, strict by default", () => {
  it("exits 3 at a value no manifest declares, naming the plugin, the value and the way out", async () => {
    await writeStubWorkspace(workspace.root, ["odd.stub", "ok.stub"])

    const { code, stderr } = await scanWith()

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain('Plugin "lang-stub" emitted extKind "stub:odd:thing" at odd.stub')
    expect(stderr).toContain("aburi scan --discover")
  })

  it("exits 3 under --strict even when the config turns strict off", async () => {
    await writeStubWorkspace(workspace.root, ["odd.stub"], { strict: false })

    expect((await scanWith("--strict")).code).toBe(EXIT.GATE)
  })

  it("exits 0 when every value is declared, and removes a record an earlier run left", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    await scanWith("--discover", "--no-timestamp")
    expect(await readRecord()).toEqual({ items: [] })

    expect((await scanWith()).code).toBe(EXIT.SUCCESS)
    await expect(readRecord()).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses --strict with --discover", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])

    const { code, stderr } = await scanWith("--strict", "--discover")

    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("--strict and --discover contradict each other")
  })
})

describe("aburi scan with strict off", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ["--discover", {}, ["--discover"]],
    ["strict: false in the config", { strict: false }, []],
    ["--no-strict over a config that says strict", { strict: true }, ["--no-strict"]],
  ])("keeps the Symbols and records each value once under %s", async (_, config, flags) => {
    await writeStubWorkspace(workspace.root, ["odd-a.stub", "odd-b.stub", "ok.stub"], config)

    const { code, stderr } = await scanWith(...flags, "--no-timestamp")

    expect(code).toBe(EXIT.SUCCESS)
    expect(await readRecord()).toEqual(ODD_TWICE)
    expect(stderr).toContain(
      "1 value(s) were emitted that the emitting plugin's manifest does not declare",
    )
    expect(stderr).toContain("    extKind stub:odd:thing — lang-stub (2)")
  })

  it("writes an empty record when nothing was undeclared, so an old one does not linger", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    await scanWith("--discover", "--no-timestamp")

    expect(await readRecord()).toEqual({ items: [] })
  })

  it("stamps the record unless timestamps are off", async () => {
    await writeStubWorkspace(workspace.root, ["ok.stub"])
    await scanWith("--discover")

    expect(await readRecord()).toMatchObject({ discoveredAt: expect.any(String) })
  })

  it("reports the values but writes no record for a diff's scan, which shares its directory", async () => {
    await writeStubWorkspace(workspace.root, ["odd.stub"], { strict: false })

    const report = await runScan({
      cwd: workspace.root,
      command: "diff",
      outputDir: resolve(workspace.root, "out"),
      format: "json",
    })

    expect(report.undeclaredVocab.map((item) => item.value)).toEqual(["stub:odd:thing"])
    expect(report.vocabDiscoveredPath).toBeNull()
  })
})
