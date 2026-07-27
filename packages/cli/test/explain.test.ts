import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXIT, runExplain } from "../src"

let scratch = ""

function makeIRWithTwoNamed(): IR {
  return {
    $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: ["ts"] },
    components: [],
    symbols: [
      {
        id: "ts:src/a.ts#getUser",
        kind: "function",
        extKind: null,
        name: "getUser",
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
          endLine: 5,
          startColumn: null,
          endColumn: null,
        },
        fingerprint: { api: "aaa", logic: "bbb", syntax: "ccc" },
        confidence: "high",
        derivedBy: [],
        dropped: false,
        dropReason: null,
      },
      {
        id: "ts:src/b.ts#getUsers",
        kind: "function",
        extKind: null,
        name: "getUsers",
        language: "ts",
        component: null,
        visibility: "public",
        decorators: [],
        signature: null,
        rules: [],
        effects: [],
        calls: [],
        source: {
          file: "src/b.ts",
          startLine: 1,
          endLine: 5,
          startColumn: null,
          endColumn: null,
        },
        fingerprint: { api: "ddd", logic: "eee", syntax: "fff" },
        confidence: "high",
        derivedBy: [],
        dropped: false,
        dropReason: null,
      },
    ],
    dependencies: [],
    stats: {
      totalFiles: 2,
      parsedFiles: 2,
      keptSymbols: 2,
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

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-explain-"))
  await mkdir(resolve(scratch, "out"), { recursive: true })
  await writeFile(
    resolve(scratch, "out/aburi.ir.json"),
    JSON.stringify(makeIRWithTwoNamed()),
    "utf8",
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("runExplain — id lookup", () => {
  it("resolves a full Symbol id and returns single markdown", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      noRescan: true,
    })
    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.SUCCESS)
    expect(outcome.markdown).toContain("getUser")
  })
})

describe("CL11 — ambiguous substring returns candidates + EXIT.INPUT_ERROR", () => {
  it("emits ambiguous outcome for a pattern that matches multiple symbols", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "getUser",
      noRescan: true,
    })
    expect(outcome.kind).toBe("ambiguous")
    if (outcome.kind !== "ambiguous") throw new Error("unreachable")
    expect(outcome.exitCode).toBe(EXIT.INPUT_ERROR)
    expect(outcome.candidates).toHaveLength(2)
  })
})

describe("runExplain — pattern with single match", () => {
  it("returns single-match markdown when substring is unique", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "getUsers",
      noRescan: true,
    })
    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    expect(outcome.symbol.id).toBe("ts:src/b.ts#getUsers")
  })
})

describe("runExplain — not-found", () => {
  it("returns not-found + EXIT.RUNTIME when nothing matches", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "nonexistent",
      noRescan: true,
    })
    expect(outcome.kind).toBe("not-found")
    expect(outcome.exitCode).toBe(EXIT.RUNTIME)
  })
})

describe("runExplain — --debug-resolution (call-resolution.md §8.1)", () => {
  it("rejects --no-rescan because the buckets only exist in a live scan", async () => {
    await expect(
      runExplain({
        cwd: scratch,
        argument: "ts:src/a.ts#getUser",
        debugResolution: true,
        noRescan: true,
      }),
    ).rejects.toThrow(/--debug-resolution needs a fresh scan/)
  })

  it("rejects --ir because an IR file cannot carry per-call diagnostics", async () => {
    await expect(
      runExplain({
        cwd: scratch,
        argument: "ts:src/a.ts#getUser",
        debugResolution: true,
        irPath: resolve(scratch, "out/aburi.ir.json"),
      }),
    ).rejects.toThrow(/cannot read an existing --ir file/)
  })

  it("ignores the IR sitting on disk and rescans instead", async () => {
    // The scratch workspace has no language plugin configured, so a rescan
    // yields zero symbols. Getting `not-found` for an id that IS present in
    // out/aburi.ir.json is exactly the proof that the file was bypassed.
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      debugResolution: true,
    })
    expect(outcome.kind).toBe("not-found")
  })
})
