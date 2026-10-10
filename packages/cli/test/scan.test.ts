import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli, runScan } from "../src"
import { CliError } from "../src/errors"
import { MemStream, writeTypeScriptWorkspace } from "./fixtures"

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-"))
  await writeTypeScriptWorkspace(scratch, "scan-fixture")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — happy path with nothing declared", () => {
  it("produces an IR and a workspace.md with zero symbols", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "both",
    })
    expect(report.exitCode).toBe(0)
    expect(report.keptSymbols).toBe(0)
    expect(report.droppedSymbols).toBe(0)
    expect(report.parseErrorCount).toBe(0)
    expect(report.timeoutCount).toBe(0)
    expect(report.irPath).not.toBeNull()
    expect(report.workspaceMdPath).not.toBeNull()
  })

  it("reports the call-resolution census even with nothing to resolve", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.callResolutionLine).toBe("calls 0 · resolved 0 · unresolved 0")
    expect(report.unresolvedCalls).toEqual([])
  })

  it("prints the census on stdout right after the kept/dropped line", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    const lines = stdout.text().trimEnd().split("\n")
    expect(lines[0]).toMatch(/^0 kept · 0 dropped · \d+ files$/)
    expect(lines[1]).toBe("calls 0 · resolved 0 · unresolved 0")
  })

  it.each([
    { format: "json" as const, writesIr: true, writesMd: false },
    { format: "md" as const, writesIr: false, writesMd: true },
  ])("--format $format writes only that artefact", async ({ format, writesIr, writesMd }) => {
    const report = await runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format })
    expect(report.irPath !== null).toBe(writesIr)
    expect(report.workspaceMdPath !== null).toBe(writesMd)
  })
})

describe("runScan — respects --ignore glob", () => {
  it("accepts CLI ignore globs without crashing (regression: empty ignore array)", async () => {
    await mkdir(resolve(scratch, "vendor"), { recursive: true })
    await writeFile(resolve(scratch, "vendor/x.ts"), "export const x = 1", "utf8")
    await writeFile(resolve(scratch, "src/kept.ts"), "export const kept = 1", "utf8")
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      ignore: ["vendor/**"],
    })
    expect(report.exitCode).toBe(0)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBe(1)
  })
})

describe("runScan — config-supplied component roots", () => {
  async function writeConfigWithRoots(roots: readonly string[]): Promise<void> {
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
        languages: ["lang-typescript"],
        components: [{ id: "shared", name: "Shared", roots, languages: ["ts"] }],
      }),
      "utf8",
    )
  }

  it("blames the config, not the IR, for a root that leaves the workspace", async () => {
    await writeConfigWithRoots(["../shared"])
    let caught: unknown
    try {
      await runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CliError)
    expect((caught as CliError).code).toBe("config-error")
    expect((caught as CliError).message).toContain("components[id=shared] root")
  })

  it("still accepts an ordinary relative root", async () => {
    await mkdir(resolve(scratch, "packages/shared"), { recursive: true })
    await writeConfigWithRoots(["packages/shared"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(0)
  })
})

describe("runScan — config-supplied publicApi", () => {
  it("normalizes the patterns, as component detection does for the detected path", async () => {
    const decomposed = "café".normalize("NFD")
    await mkdir(resolve(scratch, "packages/shared"), { recursive: true })
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
        languages: ["lang-typescript"],
        components: [
          {
            id: "shared",
            name: "Shared",
            roots: ["packages/shared"],
            languages: ["ts"],
            publicApi: [`src/${decomposed}.ts`],
          },
        ],
      }),
      "utf8",
    )
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    const ir = JSON.parse(await readFile(report.irPath ?? "", "utf8")) as {
      components: { publicApi?: string[] }[]
    }
    expect(ir.components[0]?.publicApi).toEqual([`src/${decomposed.normalize("NFC")}.ts`])
  })
})

describe("runScan — a file withdrawn during extraction", () => {
  beforeEach(async () => {
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src", "route.ts"), "export const a\u{1F642} = 1\n", "utf8")
    await writeFile(
      resolve(scratch, "src", "ok.ts"),
      "export function ok() {\n  return 1\n}\n",
      "utf8",
    )
  })

  it("exits GATE, and still writes the IR the surviving files produced", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(3)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBeGreaterThan(0)
  })

  it("names the file on the report, in skipped and in extractionFailures", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.extractionFailures).toEqual([
      {
        file: "src/route.ts",
        message: expect.stringContaining("a\u{1F642}"),
        code: "anonymous-symbol-id-attempted",
      },
    ])
    expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["src/route.ts", "extraction-failed"],
    ])
  })

  it("warns on stderr about the drop, on its own line", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(3)
    expect(stderr.text()).toContain(
      "⚠ extraction-failed (1) — a plugin threw while extracting, or its Symbols could not " +
        "enter the Document. This is the reason the run does not exit clean.",
    )
    expect(stderr.text()).toContain('    src/route.ts: qualified name "a\u{1F642}"')
  })

  it("caps the list, because a broken plugin rejects every file", async () => {
    const bad = ["export const a\u{1F642} = 1", ""].join("\n")
    for (let i = 0; i < 14; i++) {
      await writeFile(resolve(scratch, "src", `r${i}.ts`), bad, "utf8")
    }
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    const listed = stderr
      .text()
      .split("\n")
      .filter((l) => l.startsWith("    src/"))
    expect(listed).toHaveLength(10)
    expect(stderr.text()).toContain("…and 5 more")
  })

  it("names the file and the reason, not just the count", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(stderr.text()).toContain("src/route.ts: ")
    expect(stderr.text()).toContain("a\u{1F642}")
  })
})

describe("runScan — a workspace whose files all extract", () => {
  it("stays SUCCESS when files were skipped for a reason that is not a plugin throw", async () => {
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(
      resolve(scratch, "src", "ok.ts"),
      "export function ok() {\n  return 1\n}\n",
      "utf8",
    )
    await writeFile(resolve(scratch, "src", "big.ts"), `// ${"x".repeat(4000)}\n`, "utf8")
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
        languages: ["lang-typescript"],
        maxFileSizeBytes: 1024,
      }),
      "utf8",
    )
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([["src/big.ts", "over-size"]])
    expect(report.extractionFailures).toEqual([])
    expect(report.exitCode).toBe(0)
  })
})
