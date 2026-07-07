import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Writable } from "node:stream"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runCli, runDiff } from "../src"

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
    workspace: { root: ".", managers: [], languages: ["ts"] },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
    },
  }
}

function makeIRWithAdded(): IR {
  const ir = makeEmptyIR()
  return {
    ...ir,
    symbols: [
      {
        id: "ts:src/a.ts#Foo",
        kind: "function",
        extKind: null,
        name: "Foo",
        language: "ts",
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
