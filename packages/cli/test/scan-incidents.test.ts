import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, type GitRunner, runCli, runDiff, runExplain, runScan } from "../src"

/**
 * Every command that scans reports what the scan lost.
 *
 * `aburi explain` and `aburi diff` run a full scan of their own and used to discard the
 * report: no incident line, and no exit code either, so a plugin exception that withdrew a
 * file left `explain` answering "No matches" at exit 1 and `diff` answering `+0 -0 ~0` at
 * exit 0. The scan is where the incident happens, so the scan is where it is now reported.
 *
 * The fixture writes its own language plugin into the workspace and names it by relative
 * path — a ref form the loader supports, and the only way to produce a refusal or an
 * extraction throw on demand, since no in-tree plugin will do either to order.
 */

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
 * `bad.stub` is refused outright, `warn.stub` keeps a recoverable error and its Symbol,
 * `boom.stub` makes extraction throw, `ok.stub` is clean. Which of them exist is up to the
 * caller, so a fixture can differ between the base worktree and the working tree.
 */
const STUB_PLUGIN = `
const manifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "lang-stub",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
}

export const plugin = {
  manifest,
  languageId: "stub",
  fileExtensions: [".stub"],
  capabilities: {
    hasDecorators: false,
    hasGenerics: false,
    hasAsync: false,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: false,
    hasModules: false,
    hasNamespaces: false,
    hasTypeParameters: false,
    hasExplicitVisibility: false,
    hasJsDoc: false,
  },
  init: async () => {},
  parseFile: async (file) => {
    const tree = { path: file.path }
    if (file.path === "bad.stub") {
      return {
        tree,
        errors: [{ message: "unterminated string", line: 12, column: 4, recoverable: false }],
        imports: [],
      }
    }
    if (file.path === "warn.stub") {
      return {
        tree,
        errors: [{ message: "stray token", line: 2, column: 1, recoverable: true }],
        imports: [],
      }
    }
    return { tree, errors: [], imports: [] }
  },
  extractSymbols: (tree, ctx) => {
    if (ctx.file.path === "boom.stub") throw new Error("plugin exploded")
    const name = ctx.file.path.replace(/[^A-Za-z0-9]/g, "_")
    return [
      {
        id: "stub:" + ctx.file.path + "#" + name,
        kind: "function",
        extKind: null,
        name,
        visibility: "public",
        decorators: [],
        signature: null,
        source: {
          file: ctx.file.path,
          startLine: 1,
          endLine: 2,
          startColumn: null,
          endColumn: null,
        },
        derivedBy: [],
        bodyNode: tree,
        fullNode: tree,
      },
    ]
  },
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "stub-ast",
}
`

async function populate(dir: string, files: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({ name: "scan-incidents-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(dir, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.dev/schema/aburi.config.v1.json",
      languages: ["./lang-stub.mjs"],
    }),
    "utf8",
  )
  await writeFile(resolve(dir, "lang-stub.mjs"), STUB_PLUGIN, "utf8")
  for (const file of files) await writeFile(resolve(dir, file), file, "utf8")
}

/**
 * A `git` that materialises the base worktree for real, so the base scan has something to
 * scan. `makeGit`-style handlers taking no arguments cannot: the destination directory
 * arrives as `worktree add --detach <dir> <ref>`, and without creating it the base scan runs
 * against a path that does not exist.
 */
function gitWith(baseFiles: readonly string[]): GitRunner {
  return {
    async run(args) {
      const key = args.slice(0, 2).join(" ")
      if (key === "worktree add") {
        const dir = args[3]
        if (dir === undefined) throw new Error("worktree add without a destination")
        await populate(dir, baseFiles)
      }
      if (key === "rev-parse --is-shallow-repository") return { stdout: "false\n", stderr: "" }
      return { stdout: "", stderr: "" }
    },
  }
}

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-scan-incidents-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runScan — the report goes to the caller's sink", () => {
  it("says nothing without one, so embedding a scan stays silent", async () => {
    await populate(scratch, ["bad.stub", "boom.stub", "ok.stub"])
    const report = await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.skipped).toHaveLength(2)
  })

  it("emits the same lines the scan command printed, in the same order", async () => {
    await populate(scratch, ["bad.stub", "boom.stub", "warn.stub", "ok.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      warn: (m) => lines.push(m),
    })
    expect(lines).toEqual([
      "⚠ 1 file(s) had recoverable parse errors.",
      "⚠ 1 file(s) could not be parsed and were left out of the IR.",
      "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1",
      "⚠ 1 file(s) were dropped because a plugin threw while extracting them.",
      "    boom.stub: plugin exploded",
    ])
  })

  it("labels every line it owns, and leaves the per-file listing unlabelled", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const lines: string[] = []
    await runScan({
      cwd: scratch,
      outputDir: resolve(scratch, "out"),
      format: "json",
      warn: (m) => lines.push(m),
      incidentLabel: 'base ref "main"',
    })
    expect(lines).toEqual([
      '⚠ base ref "main": 1 file(s) contributed no Symbols: extraction-failed=1',
      '⚠ base ref "main": 1 file(s) were dropped because a plugin threw while extracting them.',
      "    boom.stub: plugin exploded",
    ])
  })

  it("keeps the scan command's stderr as it was", async () => {
    await populate(scratch, ["bad.stub", "boom.stub", "warn.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toBe(
      "⚠ 1 file(s) had recoverable parse errors.\n" +
        "⚠ 1 file(s) could not be parsed and were left out of the IR.\n" +
        "⚠ 2 file(s) contributed no Symbols: parse-failed=1, extraction-failed=1\n" +
        "⚠ 1 file(s) were dropped because a plugin threw while extracting them.\n" +
        "    boom.stub: plugin exploded\n",
    )
  })
})

describe("aburi explain — the scan it ran for you", () => {
  it("names the withdrawal behind a No matches answer", async () => {
    await populate(scratch, ["bad.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "bad_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    // Still not found — the Symbol genuinely is not in the IR. The difference is that the
    // reader is now told the file it would have come from was never parsed, instead of
    // reading an answer indistinguishable from "that Symbol does not exist".
    expect(code).toBe(EXIT.RUNTIME)
    expect(stderr.text()).toContain("1 file(s) could not be parsed and were left out of the IR.")
    expect(stderr.text()).toContain('No matches for "bad_stub".')
  })

  it("exits 3 when a plugin threw, even though it found what it was asked for", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(stdout.text()).toContain("ok_stub")
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toContain("dropped because a plugin threw")
  })

  it("exits 3 rather than 1 when the answer it could not find may be the fault's", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "boom_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.GATE)
  })

  it("says nothing about incidents when it read an IR off disk", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    await runScan({ cwd: scratch, outputDir: resolve(scratch, "out"), format: "json" })
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["explain", "ok_stub"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    // No scan ran, so there is no incident to report and no exit code to inherit. The live
    // signal fired when `aburi scan` wrote the file.
    expect(code).toBe(EXIT.SUCCESS)
    expect(stderr.text()).toBe("")
  })
})

describe("aburi diff — both scans it ran for you", () => {
  it("labels each side, and never calls the head by the ref spec's head label", async () => {
    await populate(scratch, ["warn.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..v1.1.0",
      git: gitWith(["bad.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(warnings).toContain(
      '⚠ base ref "main": 1 file(s) could not be parsed and were left out of the IR.',
    )
    expect(warnings).toContain("⚠ head (working tree): 1 file(s) had recoverable parse errors.")
    // §6.4 — the head is always the current checkout, whatever the ref spec calls it. A
    // `head ref "v1.1.0"` label would name a revision this scan never read.
    expect(warnings.join("\n")).not.toContain("v1.1.0")
  })

  it("gates on a plugin fault at either side and names which, with no clause triggered", async () => {
    await populate(scratch, ["ok.stub"])
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual(["base"])
    expect(report.triggered).toBeNull()
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("exits 3")
  })

  it("names both sides when both scans faulted", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: () => {},
    })
    expect(report.faultedScans).toEqual(["base", "head"])
  })

  it("says the counts can be wrong for a reason skippedFiles does not cover", async () => {
    await populate(scratch, ["warn.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["warn.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    // A file with recoverable errors is *in* both IRs, so it is in no `stats.skippedFiles`
    // and nothing about it becomes `unknown`. Its Symbol set can still be short, and the
    // added / removed counts then move with no file having gone missing.
    expect(warnings.join("\n")).toContain("recoverable parse errors")
    expect(warnings.join("\n")).toContain("added / removed")
  })

  it("keeps all three lines when a file is lost on both sides", async () => {
    await populate(scratch, ["bad.stub", "ok.stub"])
    const warnings: string[] = []
    await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["bad.stub", "ok.stub"]),
      outputDir: resolve(scratch, "out"),
      warn: (m) => warnings.push(m),
    })
    // Two per-scan facts and one diff-level synthesis. They overlap on purpose: the first
    // two say what each revision failed to read, the third says the comparison never
    // happened — which neither scan is in a position to know.
    expect(warnings.filter((m) => m.includes("contributed no Symbols"))).toHaveLength(2)
    expect(warnings.filter((m) => m.includes("skipped by both scans"))).toHaveLength(1)
    // And no fourth. A refusal is not a recoverable error, and neither scan faulted, so the
    // two lines that qualify the counts have nothing to say here.
    expect(warnings.join("\n")).not.toContain("recoverable parse errors")
    expect(warnings.join("\n")).not.toContain("exits 3")
  })

  it("reports no scan incidents in --base/--head mode, because it ran no scan", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const out = resolve(scratch, "out")
    await runScan({ cwd: scratch, outputDir: out, format: "json" })
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: resolve(out, "aburi.ir.json"),
      head: resolve(out, "aburi.ir.json"),
      outputDir: resolve(scratch, "diff-out"),
      warn: (m) => warnings.push(m),
    })
    expect(report.faultedScans).toEqual([])
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(warnings.join("\n")).not.toContain("plugin threw")
    // `parseErrorCount` lives on the scan report, never in the IR, so this mode cannot know
    // whether either document was written from a clean parse.
    expect(warnings.join("\n")).not.toContain("recoverable parse errors")
  })

  it("still exits 3 with the clause message when a gate trips alongside a fault", async () => {
    await populate(scratch, ["ok.stub"])
    const stdout = new MemStream()
    const stderr = new MemStream()
    const report = await runDiff({
      cwd: scratch,
      refSpec: "main..HEAD",
      git: gitWith(["boom.stub", "ok.stub", "extra.stub"]),
      outputDir: resolve(scratch, "out"),
      failOn: "removed",
      warn: (m) => stderr.write(`${m}\n`),
    })
    expect(stdout.text()).toBe("")
    expect(report.triggered).not.toBeNull()
    expect(report.faultedScans).toEqual(["base"])
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(stderr.text()).toContain("dropped because a plugin threw")
  })
})

describe("runExplain — the report reaches a programmatic caller too", () => {
  it("hands the incidents to the supplied sink rather than to a stream", async () => {
    await populate(scratch, ["boom.stub", "ok.stub"])
    const warnings: string[] = []
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ok_stub",
      warn: (m) => warnings.push(m),
    })
    expect(outcome.exitCode).toBe(EXIT.GATE)
    expect(warnings.join("\n")).toContain("plugin threw")
  })
})
