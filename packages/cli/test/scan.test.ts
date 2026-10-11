import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, runScan, type ScanOptions } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig, writeTypeScriptWorkspace } from "./workspace"

const workspace = useScratchWorkspace("scan")

beforeEach(async () => {
  await writeTypeScriptWorkspace(workspace.root, "scan-fixture")
})

function scan(options: Omit<ScanOptions, "cwd" | "outputDir"> = {}) {
  return runScan({
    cwd: workspace.root,
    outputDir: resolve(workspace.root, "out"),
    format: "json",
    ...options,
  })
}

async function declaredComponent(component: Record<string, unknown>): Promise<void> {
  await writeConfig(workspace.root, {
    ...TYPESCRIPT,
    components: [{ id: "shared", name: "Shared", languages: ["ts"], ...component }],
  })
}

describe("aburi scan — a workspace that declares nothing", () => {
  it.each([
    ["both", true, true],
    ["json", true, false],
    ["md", false, true],
  ] as const)("writes what --format %s asks for", async (format, writesIr, writesMd) => {
    const report = await scan({ format })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report).toMatchObject({
      keptSymbols: 0,
      droppedSymbols: 0,
      parseErrorCount: 0,
      timeoutCount: 0,
    })
    expect(report.irPath !== null).toBe(writesIr)
    expect(report.workspaceMdPath !== null).toBe(writesMd)
  })

  it("reports the call-resolution census even with nothing to resolve", async () => {
    const report = await scan()

    expect(report.callResolutionLine).toBe("calls 0 · resolved 0 · unresolved 0")
    expect(report.unresolvedCalls).toEqual([])
  })

  it("prints the census on stdout right after the kept/dropped line", async () => {
    const { stdout } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    const lines = stdout.trimEnd().split("\n")
    expect(lines[0]).toMatch(/^0 kept · 0 dropped · \d+ files$/)
    expect(lines[1]).toBe("calls 0 · resolved 0 · unresolved 0")
  })
})

describe("aburi scan — what the caller and the config add", () => {
  it("leaves out the files under a CLI --ignore glob", async () => {
    await workspace.writeSource("vendor/x.ts", "export const x = 1")
    await workspace.writeSource("src/kept.ts", "export const kept = 1")

    const report = await scan({ ignore: ["vendor/**"] })

    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.keptSymbols).toBe(1)
  })

  it("accepts an ordinary relative component root", async () => {
    await workspace.writeSource("packages/shared/index.ts", "export const shared = 1\n")
    await declaredComponent({ roots: ["packages/shared"] })

    expect((await scan()).exitCode).toBe(EXIT.SUCCESS)
  })

  it("blames the config, not the IR, for a component root that leaves the workspace", async () => {
    await declaredComponent({ roots: ["../shared"] })

    const error = await errorFrom(CliError, () => scan())

    expect(error.code).toBe("config-error")
    expect(error.message).toContain("components[id=shared] root")
  })

  it("normalizes a component's publicApi patterns, as component detection does", async () => {
    const decomposed = "café".normalize("NFD")
    await workspace.writeSource("packages/shared/index.ts", "export const shared = 1\n")
    await declaredComponent({ roots: ["packages/shared"], publicApi: [`src/${decomposed}.ts`] })

    const report = await scan()

    const ir = JSON.parse(await readFile(report.irPath ?? "", "utf8")) as {
      components: { publicApi?: string[] }[]
    }
    expect(ir.components[0]?.publicApi).toEqual([`src/${decomposed.normalize("NFC")}.ts`])
  })
})

describe("aburi scan — a file withdrawn during extraction", () => {
  const WITHDRAWN = "export const a\u{1F642} = 1\n"

  beforeEach(async () => {
    await workspace.writeSource("src/route.ts", WITHDRAWN)
    await workspace.writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
  })

  it("exits 3, names the file, and still writes the IR the surviving files produced", async () => {
    const report = await scan()

    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBeGreaterThan(0)
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

  it("warns on stderr about the drop, naming the file and the reason", async () => {
    const { code, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code).toBe(EXIT.GATE)
    expect(stderr).toContain(
      "⚠ extraction-failed (1) — a plugin threw while extracting, or its Symbols could not " +
        "enter the Document. This is the reason the run does not exit clean.",
    )
    expect(stderr).toContain('    src/route.ts: qualified name "a\u{1F642}"')
  })

  it("caps the list, because a broken plugin rejects every file", async () => {
    for (let i = 0; i < 14; i++) await workspace.writeSource(`src/r${i}.ts`, WITHDRAWN)

    const { stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(stderr.split("\n").filter((l) => l.startsWith("    src/"))).toHaveLength(10)
    expect(stderr).toContain("…and 5 more")
  })
})

describe("aburi scan — files skipped for a reason that is not a plugin throw", () => {
  it("stays green", async () => {
    await workspace.writeSource("src/ok.ts", "export function ok() {\n  return 1\n}\n")
    await workspace.writeSource("src/big.ts", `// ${"x".repeat(4000)}\n`)
    await writeConfig(workspace.root, { ...TYPESCRIPT, maxFileSizeBytes: 1024 })

    const report = await scan()

    expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([["src/big.ts", "over-size"]])
    expect(report.extractionFailures).toEqual([])
    expect(report.exitCode).toBe(EXIT.SUCCESS)
  })
})
