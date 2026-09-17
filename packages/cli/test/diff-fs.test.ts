import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import { makeLanguageId } from "@aburi/core"
import { DiffError } from "@aburi/diff"
import type { CallResolutionStats, IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { classifyDiffError, EXIT, runCli, runDiff } from "../src"
import { CliError } from "../src/errors"
import { symbolId } from "./fixtures"

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

let scratch = ""

function makeEmptyIR(): IR {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

function makeIRWithAdded(): IR {
  const ir = makeEmptyIR()
  return {
    ...ir,
    symbols: [
      {
        id: symbolId("ts:src/a.ts#Foo"),
        kind: "function",
        extKind: null,
        name: "Foo",
        language: makeLanguageId("ts"),
        component: null,
        visibility: "public",
        decorators: [],
        signature: null,
        rules: [],
        effects: [],
        calls: [],
        source: {
          file: "src/a.ts",
          startLine: 1,
          endLine: 10,
          startColumn: null,
          endColumn: null,
        },
        fingerprint: { api: "aaa000000000", logic: "bbb000000000", syntax: "ccc000000000" },
        confidence: "high",
        derivedBy: [],
        dropped: false,
        dropReason: null,
      },
    ],
    stats: { ...ir.stats, keptSymbols: 1 },
  }
}

/** The same symbol `count` times over, which is all the size cap cares about. */
function makeIRWithManyAdded(count: number): IR {
  const one = makeIRWithAdded()
  const template = one.symbols[0]
  if (template === undefined) throw new Error("expected a template symbol")
  const symbols = Array.from({ length: count }, (_, i) => {
    const name = `Added${String(i).padStart(4, "0")}`
    return {
      ...template,
      id: symbolId(`ts:src/${name}.ts#${name}`),
      name,
      source: { ...template.source, file: `src/${name}.ts` },
    }
  })
  return { ...one, symbols, stats: { ...one.stats, keptSymbols: count } }
}

/**
 * The base side of a two-section diff: one symbol the head keeps but changes. Without it every
 * fixture here renders a single `Added` section, and a capped run drops that one section and
 * returns the heading — which measures well under any budget worth testing and so never
 * exercises the path where some sections survive and others go.
 */
function makeIRWithKept(apiFingerprint: string): IR {
  const one = makeIRWithAdded()
  const template = one.symbols[0]
  if (template === undefined) throw new Error("expected a template symbol")
  return {
    ...one,
    symbols: [
      {
        ...template,
        id: symbolId("ts:src/kept.ts#Kept"),
        name: "Kept",
        source: { ...template.source, file: "src/kept.ts" },
        fingerprint: { ...template.fingerprint, api: apiFingerprint },
      },
    ],
    stats: { ...one.stats, keptSymbols: 1 },
  }
}

/**
 * That same symbol, changed, plus `count` added ones: `API changes` above `Added`. Sorted by id,
 * which the IR's own integrity check requires of every document the reader accepts.
 */
function makeIRWithChangeAndManyAdded(count: number): IR {
  const changed = makeIRWithKept("zzz000000000")
  const added = makeIRWithManyAdded(count)
  const symbols = [...changed.symbols, ...added.symbols].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  return { ...added, symbols, stats: { ...added.stats, keptSymbols: symbols.length } }
}

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-diff-"))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runDiff — --base/--head (file mode)", () => {
  it("diffs two IR files and writes out/diff.json + out/diff.md", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithAdded()), "utf8")
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    expect(report.summaryLine).toBe("+1 -0 ~0 ↔0 ⤴0")
    if (report.diffJsonPath === null) throw new Error("expected diffJsonPath")
    const diffJson = await readFile(report.diffJsonPath, "utf8")
    expect(diffJson).toMatch(/"added"\s*:\s*1/)
    if (report.diffMdPath === null) throw new Error("expected diffMdPath")
    const diffMd = await readFile(report.diffMdPath, "utf8")
    expect(diffMd).toContain("Added")
  })

  it("caps diff.md at --max-bytes, leaving diff.json whole", async () => {
    // What GitHub rejects at 65536 bytes is the comment body, not the JSON: the cap belongs to
    // the document that gets posted, and the artefact beside it still holds every symbol.
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeIRWithKept("aaa000000000")), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithChangeAndManyAdded(400)), "utf8")

    const uncapped = await runDiff({ cwd: scratch, base: basePath, head: headPath, refSpec: null })
    if (uncapped.diffMdPath === null) throw new Error("expected diffMdPath")
    const full = await readFile(uncapped.diffMdPath, "utf8")
    expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(20_000)
    expect(full).toContain("## ⚠ API changes")
    expect(full).toContain("## ➕ Added")

    const capped = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      maxBytes: 2_000,
    })
    if (capped.diffMdPath === null) throw new Error("expected diffMdPath")
    const markdown = await readFile(capped.diffMdPath, "utf8")
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(2_000)
    // The budget was met by dropping the lower section and keeping the higher one, which is the
    // path the flag exists for — not by dropping everything and returning the heading.
    expect(markdown).toContain("## ⚠ API changes")
    expect(markdown).not.toContain("## ➕ Added")
    expect(markdown).toContain("➕ Added")
    expect(markdown).toContain("**Summary**: +400 added")

    if (capped.diffJsonPath === null) throw new Error("expected diffJsonPath")
    const diffJson = await readFile(capped.diffJsonPath, "utf8")
    expect(diffJson).toContain("Added0399")
  })

  it("warns, rather than fails, when a budget cannot be met", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithManyAdded(20)), "utf8")
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      maxBytes: 10,
      warn: (message) => warnings.push(message),
    })
    expect(report.exitCode).toBe(EXIT.SUCCESS)
    if (report.diffMdPath === null) throw new Error("expected diffMdPath")
    const written = Buffer.byteLength(await readFile(report.diffMdPath, "utf8"), "utf8")
    expect(written).toBeGreaterThan(10)
    expect(warnings.join("\n")).toContain(`diff.md is ${written} bytes, over the 10 requested`)
  })

  it("warns that --max-bytes has nothing to cap under --format json", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithAdded()), "utf8")
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      format: "json",
      maxBytes: 4_000,
      warn: (message) => warnings.push(message),
    })
    expect(report.diffMdPath).toBeNull()
    expect(warnings.join("\n")).toContain("--max-bytes has no effect under --format json")
  })

  it("rejects a --max-bytes that is not a positive integer, before scanning anything", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithAdded()), "utf8")
    await expect(
      runDiff({ cwd: scratch, base: basePath, head: headPath, refSpec: null, maxBytes: 0 }),
    ).rejects.toMatchObject({ code: "input-error" })
  })

  it("fires --fail-on and returns EXIT.GATE", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithAdded()), "utf8")
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      failOn: "added",
    })
    expect(report.exitCode).toBe(EXIT.GATE)
    expect(report.triggered?.clause.token).toBe("added")
    expect(report.triggered?.observed).toBe(1)
  })
})

describe("runDiff — call-resolution census on stdout (call-resolution.md §8.1)", () => {
  async function writePair(head: IR): Promise<{ basePath: string; headPath: string }> {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(head), "utf8")
    return { basePath, headPath }
  }

  /**
   * Integrity invariant #15 cross-checks the counters against `symbols[]`, so
   * the fixture has to carry the call sites it claims. Every call here is left
   * unresolved, which keeps `dependencies[]` empty and invariant #14 happy.
   */
  function headWithUnresolvedCalls(callResolution: CallResolutionStats): IR {
    const head = makeIRWithAdded()
    const count = callResolution.totalCalls - callResolution.resolvedCalls
    const symbol = head.symbols[0]
    if (symbol === undefined) throw new Error("fixture must carry one symbol")
    symbol.calls = Array.from({ length: count }, (_, i) => ({
      target: `mystery${i}`,
      line: i + 2,
      resolved: null,
    }))
    head.stats.callResolution = callResolution
    return head
  }

  it("renders the head IR's counters", async () => {
    const head = headWithUnresolvedCalls({
      totalCalls: 3,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 1, dynamic: 2, ambiguous: 0, noMatch: 0 },
    })
    const { basePath, headPath } = await writePair(head)
    const report = await runDiff({ cwd: scratch, base: basePath, head: headPath, refSpec: null })
    expect(report.callResolutionLine).toBe(
      "calls 3 · resolved 0 · unresolved 3 (external 1 · dynamic 2)",
    )
  })

  it("omits the bucket list when the head resolved everything", async () => {
    const head = headWithUnresolvedCalls({
      totalCalls: 0,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
    })
    const { basePath, headPath } = await writePair(head)
    const report = await runDiff({ cwd: scratch, base: basePath, head: headPath, refSpec: null })
    expect(report.callResolutionLine).toBe("calls 0 · resolved 0 · unresolved 0")
  })

  it("is null for a head IR produced before the counters existed, and says why on stderr", async () => {
    const { basePath, headPath } = await writePair(makeIRWithAdded())
    const warnings: string[] = []
    const report = await runDiff({
      cwd: scratch,
      base: basePath,
      head: headPath,
      refSpec: null,
      warn: (m) => warnings.push(m),
    })
    expect(report.callResolutionLine).toBeNull()
    // Dropping the line without a word would leave the reviewer reading the
    // Slice View unaware that the one signal explaining a suspicious singleton
    // is absent.
    expect(warnings.join("\n")).toContain("no stats.callResolution")
  })

  it("prints nothing but the summary when the census is unavailable", async () => {
    const { basePath, headPath } = await writePair(makeIRWithAdded())
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: [
        "diff",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output-dir",
        resolve(scratch, "out"),
        "--format",
        "json",
      ],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(stdout.text().trimEnd().split("\n")).toEqual(["+1 -0 ~0 ↔0 ⤴0"])
    expect(stderr.text()).toContain("no stats.callResolution")
  })

  it("prints the line right after the summary", async () => {
    const head = headWithUnresolvedCalls({
      totalCalls: 1,
      resolvedCalls: 0,
      unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 1, noMatch: 0 },
    })
    const { basePath, headPath } = await writePair(head)
    const stdout = new MemStream()
    const stderr = new MemStream()
    await runCli({
      argv: [
        "diff",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output-dir",
        resolve(scratch, "out"),
      ],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    const lines = stdout.text().trimEnd().split("\n")
    expect(lines[0]).toBe("+1 -0 ~0 ↔0 ⤴0")
    expect(lines[1]).toBe("calls 1 · resolved 0 · unresolved 1 (ambiguous 1)")
  })
})

describe("argv routing for --max-bytes", () => {
  it("caps the written diff.md from runCli end-to-end", async () => {
    // The one hop the action depends on: `--max-bytes 65507` on the command line reaching
    // `projectDiff`. Delete the forwarding line in `run.ts` and every other test in this repo
    // still passes — the CLI exits 0, writes a full-size diff.md, and the comment silently
    // stops being posted, which is the bug this flag exists to prevent.
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeIRWithKept("aaa000000000")), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithChangeAndManyAdded(400)), "utf8")
    const outputDir = resolve(scratch, "out")
    const mdPath = resolve(outputDir, "diff.md")

    const uncapped = await runCli({
      argv: ["diff", "--base", basePath, "--head", headPath, "--output-dir", outputDir],
      stdout: new MemStream(),
      stderr: new MemStream(),
      env: {},
      cwd: scratch,
    })
    expect(uncapped).toBe(EXIT.SUCCESS)
    expect(Buffer.byteLength(await readFile(mdPath, "utf8"), "utf8")).toBeGreaterThan(20_000)

    const capped = await runCli({
      argv: [
        "diff",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output-dir",
        outputDir,
        "--max-bytes",
        "2000",
      ],
      stdout: new MemStream(),
      stderr: new MemStream(),
      env: {},
      cwd: scratch,
    })
    expect(capped).toBe(EXIT.SUCCESS)
    const markdown = await readFile(mdPath, "utf8")
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(2000)
    expect(markdown).toContain("## ⚠ API changes")
    expect(markdown).not.toContain("## ➕ Added")
  })
})

describe("CL9 — argv routing for --fail-on", () => {
  it("returns EXIT.GATE from runCli end-to-end", async () => {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await writeFile(basePath, JSON.stringify(makeEmptyIR()), "utf8")
    await writeFile(headPath, JSON.stringify(makeIRWithAdded()), "utf8")
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: [
        "diff",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output-dir",
        resolve(scratch, "out"),
        "--fail-on",
        "added",
      ],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code).toBe(EXIT.GATE)
    expect(stderr.text()).toContain("--fail-on added tripped")
  })
})

describe("classifyDiffError — DiffError to exit-code mapping (cli-spec.md §9)", () => {
  it("maps user-fixable diff failures to config-error", () => {
    const codes = [
      "schema-mismatch",
      "invalid-line-fuzz",
      "ir-shape-invalid",
      "ir-identity-collision",
    ] as const
    for (const code of codes) {
      const cliError = classifyDiffError(new DiffError(`boom: ${code}`, { code }))
      expect(cliError.code).toBe("config-error")
      expect(cliError.message).toBe(`boom: ${code}`)
    }
  })

  it("maps slice-invariant-violated to runtime-error and says it is an Aburi bug", () => {
    // slice-view.md §7.4: this code fires only on a producer bug, so reporting
    // it as a config error would send the reader to aburi.json for nothing.
    const cause = new DiffError("SliceRecord slice:a: members[] is empty.", {
      code: "slice-invariant-violated",
      value: "slice:a",
    })
    const cliError = classifyDiffError(cause)
    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("bug in Aburi, not in your configuration")
    expect(cliError.message).toContain("members[] is empty")
    expect(cliError.cause).toBe(cause)
  })

  it("keeps what a code it has no arm for said, rather than throwing it away", () => {
    // `@aburi/diff` and `@aburi/cli` version independently, so a compiled switch can meet a
    // code it never saw. The compile-time check cannot help an installed tree, and discarding
    // the message would leave the reader with nothing about the diff that failed.
    const cause = new DiffError("Symbol sym:a: fingerprint is not a string.", {
      code: "symbol-fingerprint-invalid",
    } as unknown as ConstructorParameters<typeof DiffError>[1])

    const cliError = classifyDiffError(cause)

    expect(cliError.code).toBe("runtime-error")
    expect(cliError.message).toContain("fingerprint is not a string")
    expect(cliError.message).toContain("symbol-fingerprint-invalid")
    expect(cliError.cause).toBe(cause)
  })

  it("starts the report instruction on its own line", () => {
    const cause = new DiffError("SliceRecord slice:a: members[] is empty.", {
      code: "slice-invariant-violated",
      value: "slice:a",
    })

    expect(classifyDiffError(cause).message).toContain("empty.\nThis is a bug in Aburi")
  })
})

describe("runDiff — a base IR that is not shaped like a Document", () => {
  /** Write an IR file with one top-level key removed. */
  async function writeIRWithout(path: string, key: string): Promise<void> {
    const ir = makeEmptyIR() as unknown as Record<string, unknown>
    delete ir[key]
    await writeFile(path, JSON.stringify(ir), "utf8")
  }

  /** Write an IR file with one top-level key replaced. */
  async function writeIRWith(path: string, key: string, value: unknown): Promise<void> {
    const ir = makeEmptyIR() as unknown as Record<string, unknown>
    ir[key] = value
    await writeFile(path, JSON.stringify(ir), "utf8")
  }

  async function readErrorFor(write: (path: string) => Promise<void>): Promise<CliError> {
    const basePath = resolve(scratch, "base.json")
    const headPath = resolve(scratch, "head.json")
    await write(basePath)
    await writeFile(headPath, JSON.stringify(makeEmptyIR()), "utf8")
    let caught: unknown
    try {
      await runDiff({ cwd: scratch, base: basePath, head: headPath, refSpec: null })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CliError)
    return caught as CliError
  }

  it.each([
    "workspace",
    "stats",
    "symbols",
    "components",
    "dependencies",
    "generator",
  ])("names the missing %s instead of reporting an unexplained load failure", async (key) => {
    // The invariant list exists to say which rule broke. A malformed Document used to
    // reach a `TypeError` inside the checker, which the CLI reported as "failed integrity
    // check: Cannot read properties of undefined" — the caller learned only that
    // something went wrong inside Aburi.
    const error = await readErrorFor((path) => writeIRWithout(path, key))
    expect(error.code).toBe("config-error")
    expect(error.message).toContain("[#20]")
    expect(error.message).toContain(key)
    expect(error.message).not.toContain("Cannot read properties")
  })

  it.each([
    ["symbols", {}],
    ["workspace", null],
    ["stats", 7],
  ])("names %s when it is present but the wrong type", async (key, value) => {
    // Deleting a key is not the only corruption a hand-edit produces, and the pre-check
    // this replaced rejected `"symbols": {}` too.
    const error = await readErrorFor((path) => writeIRWith(path, key, value))
    expect(error.code).toBe("config-error")
    expect(error.message).toContain("[#20]")
    expect(error.message).toContain(key)
  })

  it("names the record and the field for a corruption inside a Symbol", async () => {
    // The field the diff reads without the invariants ever having looked at it.
    const error = await readErrorFor((path) =>
      writeIRWith(path, "symbols", [
        { ...(makeIRWithAdded().symbols[0] as object), fingerprint: undefined },
      ]),
    )
    expect(error.message).toContain("symbols[0]")
    expect(error.message).toContain("fingerprint")
    expect(error.message).not.toContain("Cannot read properties")
  })
})
