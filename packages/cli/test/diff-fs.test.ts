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
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
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
