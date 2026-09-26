import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli, runScan, VOCAB_DISCOVERED_FILENAME } from "../src"
import { MemStream } from "./fixtures"
import { populate } from "./stub-language"

/**
 * `strict` (config.md, cli-spec.md): a value a plugin emits without its manifest declaring it
 * stops a strict run with exit 3, and is kept and recorded otherwise. `odd.stub` is the file
 * whose Symbol the stub plugin gives the undeclared extKind `stub:odd:thing`.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-strict-vocab-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scanWith(argv: readonly string[]) {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const code = await runCli({
    argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json", ...argv],
    stdout,
    stderr,
    env: {},
    cwd: scratch,
  })
  return { code, stderr: stderr.text() }
}

async function setStrictInConfig(strict: boolean): Promise<void> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["./lang-stub.mjs"],
      strict,
    }),
    "utf8",
  )
}

async function readRecord(): Promise<unknown> {
  return JSON.parse(await readFile(resolve(scratch, "out", VOCAB_DISCOVERED_FILENAME), "utf8"))
}

describe("aburi scan, strict by default", () => {
  it("CL8: exits 3 and names the plugin and the value", async () => {
    await populate(scratch, ["odd.stub", "ok.stub"])
    const { code, stderr } = await scanWith([])
    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain('Plugin "lang-stub" emitted extKind "stub:odd:thing" at odd.stub')
    expect(stderr).toContain("aburi scan --discover")
  })

  it("exits 3 under --strict even when the config turns strict off", async () => {
    await populate(scratch, ["odd.stub"])
    await setStrictInConfig(false)
    expect((await scanWith(["--strict"])).code).toBe(EXIT.GATE)
  })

  it("exits 0 when every value is declared", async () => {
    await populate(scratch, ["ok.stub"])
    expect((await scanWith([])).code).toBe(EXIT.SUCCESS)
  })
})

describe("aburi scan with strict off", () => {
  const expected = {
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

  it("CL7 / V12: keeps the Symbols, records each value once and says so (--discover)", async () => {
    await populate(scratch, ["odd-a.stub", "odd-b.stub", "ok.stub"])
    const { code, stderr } = await scanWith(["--discover", "--no-timestamp"])
    expect(code).toBe(EXIT.SUCCESS)
    expect(await readRecord()).toEqual(expected)
    expect(stderr).toContain("1 value(s) were emitted that no plugin manifest declares")
    expect(stderr).toContain("    extKind stub:odd:thing — lang-stub (2)")
  })

  it("does the same for strict: false in the config, and for --no-strict", async () => {
    await populate(scratch, ["odd-a.stub", "odd-b.stub"])
    await setStrictInConfig(false)
    expect((await scanWith(["--no-timestamp"])).code).toBe(EXIT.SUCCESS)
    expect(await readRecord()).toEqual(expected)
    await setStrictInConfig(true)
    expect((await scanWith(["--no-strict", "--no-timestamp"])).code).toBe(EXIT.SUCCESS)
    expect(await readRecord()).toEqual(expected)
  })

  it("writes an empty record when nothing was undeclared, so an old one does not linger", async () => {
    await populate(scratch, ["ok.stub"])
    await scanWith(["--discover", "--no-timestamp"])
    expect(await readRecord()).toEqual({ items: [] })
  })

  it("stamps the record unless timestamps are off", async () => {
    await populate(scratch, ["ok.stub"])
    await scanWith(["--discover"])
    expect(await readRecord()).toMatchObject({ discoveredAt: expect.any(String) })
  })

  it("CL8a: refuses --strict with --discover", async () => {
    await populate(scratch, ["ok.stub"])
    const { code, stderr } = await scanWith(["--strict", "--discover"])
    expect(code).toBe(EXIT.INPUT_ERROR)
    expect(stderr).toContain("--strict and --discover contradict each other")
  })

  it("CL8b: reports but writes no record for a diff's scan, which shares its directory with another", async () => {
    await populate(scratch, ["odd.stub"])
    await setStrictInConfig(false)
    const report = await runScan({
      cwd: scratch,
      command: "diff",
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.undeclaredVocab.map((item) => item.value)).toEqual(["stub:odd:thing"])
    expect(report.vocabDiscoveredPath).toBeNull()
  })
})
