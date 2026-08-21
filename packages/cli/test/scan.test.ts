import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runCli, runScan } from "../src"
import { CliError } from "../src/errors"

class MemStream extends Writable {
  chunks: string[] = []
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(chunk.toString())
    cb()
  }
  text(): string {
    return this.chunks.join("")
  }
}

/**
 * runScan integration tests — use a minimal on-disk workspace so config resolution and
 * plugin loading follow the real code paths. The point is to lock in the ScanReport shape
 * that `run.ts` reads to decide whether to emit stderr warnings.
 *
 * The workspace holds one source file that parses and declares nothing, so every report here
 * comes back with zero Symbols while the scan still read the repository. That distinction is
 * the one the coverage gate rests on: a file that parses cleanly and declares nothing is
 * counted as parsed, and a workspace where nothing parsed is not a success. The fixture used
 * to carry no source file at all, which is now the state `scan-coverage.test.ts` covers.
 *
 * The config names a language plugin because a scan without one cannot produce a
 * schema-valid IR — `workspace.languages` is `minItems: 1` — and is refused up front.
 */

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "scan-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
    "utf8",
  )
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/quiet.ts"), "// declares nothing\n", "utf8")
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
    expect(report.irPath).not.toBeNull()
    expect(report.workspaceMdPath).not.toBeNull()
  })

  it("reports the call-resolution census even with nothing to resolve (§8.1)", async () => {
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

  it("--format json skips markdown", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.irPath).not.toBeNull()
    expect(report.workspaceMdPath).toBeNull()
  })

  it("--format md skips the IR JSON", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "md",
    })
    expect(report.irPath).toBeNull()
    expect(report.workspaceMdPath).not.toBeNull()
  })

  it("exposes a skipped array (may include files no loaded plugin claims)", async () => {
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(Array.isArray(report.skipped)).toBe(true)
    expect(report.parseErrorCount).toBe(0)
    expect(report.timeoutCount).toBe(0)
    // package.json is discovered but no loaded plugin claims `.json`, so it may land on
    // the skipped list. Assert the shape rather than the exact contents.
    for (const entry of report.skipped) {
      expect(typeof entry.path).toBe("string")
      expect(typeof entry.reason).toBe("string")
    }
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
    // `vendor/x.ts` is excluded before routing and `src/kept.ts` is not, so the glob is
    // accepted, applied to the file it names, and the run still writes an IR.
    expect(report.irPath).not.toBeNull()
    expect(report.keptSymbols).toBe(1)
  })
})

describe("runScan — config-supplied component roots", () => {
  async function writeConfigWithRoots(roots: readonly string[]): Promise<void> {
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.dev/schema/aburi.config.v1.json",
        languages: ["lang-typescript"],
        components: [{ id: "shared", name: "Shared", roots, languages: ["ts"] }],
      }),
      "utf8",
    )
  }

  it("blames the config, not the IR, for a root that leaves the workspace", async () => {
    // `RelativePath` in the config schema constrains only `minLength` and "no backslash",
    // so this is schema-valid and reaches component construction untouched. Left to run, it
    // would be caught at the very end by `assertIRIntegrity` — reported against
    // `components[id=shared].roots` as though the Document were at fault, and exiting 1
    // through the generic handler rather than 2 as a problem with the scanned project.
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
    // ir-schema.md §1.2: `@aburi/diff` compares `publicApi` against the previous revision's,
    // which was read off disk and is therefore NFC. An un-normalized entry written here
    // reports a `publicApiChanged` for a component nobody touched.
    const decomposed = "café".normalize("NFD")
    await mkdir(resolve(scratch, "packages/shared"), { recursive: true })
    await writeFile(
      resolve(scratch, "aburi.json"),
      JSON.stringify({
        $schema: "https://aburi.dev/schema/aburi.config.v1.json",
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

/**
 * A file a plugin throws on is withdrawn rather than fatal (`lang-plugin.md` §7.2), and the
 * IR is still written — so the exit code is the only thing left to tell a CI job that
 * something in the run is broken rather than merely partial.
 *
 * `export const { GET, POST } = handlers` is the reachable trigger with real plugins: the
 * text of the destructuring pattern reaches `makeSymbolId` as a qualified name and the id
 * grammar refuses it.
 */
describe("runScan — a file a plugin threw on", () => {
  beforeEach(async () => {
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(
      resolve(scratch, "src", "route.ts"),
      "const handlers = { GET: 1, POST: 2 }\nexport const { GET, POST } = handlers\n",
      "utf8",
    )
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
        message: expect.stringContaining("{ GET, POST }"),
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
    // The reason that earned the 3, and the file that earned it, on the reader's screen —
    // the message being the plugin's own account of what it refused.
    expect(stderr.text()).toContain("⚠ extraction-failed (1) — a plugin threw while extracting.")
    expect(stderr.text()).toContain('    src/route.ts: qualified name "{ GET, POST }"')
  })

  it("caps the list, because a broken plugin rejects every file", async () => {
    // A plugin broken enough to reject one file usually rejects them all, and the
    // untruncated list is then the whole workspace — which on CI scrolls every other
    // warning out of the log it was meant to appear in.
    const bad = ["const h = { GET: 1, POST: 2 }", "export const { GET, POST } = h", ""].join("\n")
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
    // The core logs the same per file, but through its own sink: it disappears at
    // `ABURI_LOG_LEVEL=error` and never reaches an injected stream, so a caller reading
    // this one would otherwise be told a number and nothing else.
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
    expect(stderr.text()).toContain("{ GET, POST }")
  })
})

describe("runScan — a workspace whose files all extract", () => {
  it("exits SUCCESS with an empty extractionFailures", async () => {
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(
      resolve(scratch, "src", "ok.ts"),
      "export function ok() {\n  return 1\n}\n",
      "utf8",
    )
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(0)
    expect(report.extractionFailures).toEqual([])
  })

  it("stays SUCCESS when files were skipped for a reason that is not a plugin throw", async () => {
    // A file over `maxFileSizeBytes` is skipped, and skipping it says nothing is broken —
    // it is a deterministic budget doing its job. Gating on `skipped` as a whole rather than
    // on `extractionFailures` would turn every repository with one large generated file red.
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
        $schema: "https://aburi.dev/schema/aburi.config.v1.json",
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
