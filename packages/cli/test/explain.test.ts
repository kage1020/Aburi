import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { makeLanguageId } from "@aburi/core"
import type { IR } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, runExplain } from "../src"
import { symbolId } from "./fixtures"

let scratch = ""

function makeIRWithTwoNamed(): IR {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
    generator: { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: { root: ".", managers: [], languages: [makeLanguageId("ts")] },
    components: [],
    symbols: [
      {
        id: symbolId("ts:src/a.ts#getUser"),
        kind: "function",
        extKind: null,
        name: "getUser",
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
        id: symbolId("ts:src/b.ts#getUsers"),
        kind: "function",
        extKind: null,
        name: "getUsers",
        language: makeLanguageId("ts"),
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
  // The on-disk IR above names `src/a.ts` and `src/b.ts`, which do not exist on disk. A
  // rescan therefore finds nothing, and `--debug-resolution` returning `not-found` for an
  // id that IS in the file is what proves the file was bypassed. The config exists so the
  // rescan is a real one rather than a run refused for having no language plugin.
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "explain-fixture", private: true }),
    "utf8",
  )
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
    }),
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
    // The workspace has no source files, so a rescan yields zero symbols. Getting
    // `not-found` for an id that IS present in out/aburi.ir.json is exactly the proof
    // that the file was bypassed.
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      debugResolution: true,
    })
    expect(outcome.kind).toBe("not-found")
  })
})

/**
 * All three lookup arms write through the same path, and each is reached by a different
 * argument shape — an arm that kept its own `writeFile` would pass the other two's tests.
 */
describe("CL26 — --output under directories that do not exist", () => {
  it("creates them for an id lookup", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      noRescan: true,
      outputPath: "generated/explain/get-user.md",
    })

    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    const written = resolve(scratch, "generated/explain/get-user.md")
    expect(outcome.writtenTo).toBe(written)
    expect(await readFile(written, "utf8")).toContain("getUser")
  })

  it("creates them for a file lookup", async () => {
    // The file arm claims the argument only for a path on disk or one the IR skipped; the
    // fixture IR names `src/a.ts` without the workspace holding it.
    await mkdir(resolve(scratch, "src"), { recursive: true })
    await writeFile(resolve(scratch, "src/a.ts"), "export function getUser() {}\n", "utf8")

    const outcome = await runExplain({
      cwd: scratch,
      argument: "src/a.ts",
      noRescan: true,
      outputPath: "generated/explain/a.md",
    })

    expect(outcome.kind).toBe("file")
    if (outcome.kind !== "file") throw new Error("unreachable")
    const written = resolve(scratch, "generated/explain/a.md")
    expect(outcome.writtenTo).toBe(written)
    expect(await readFile(written, "utf8")).toContain("getUser")
  })

  it("creates them for a pattern lookup", async () => {
    const outcome = await runExplain({
      cwd: scratch,
      argument: "getUsers",
      noRescan: true,
      outputPath: "generated/explain/get-users.md",
    })

    expect(outcome.kind).toBe("single")
    if (outcome.kind !== "single") throw new Error("unreachable")
    const written = resolve(scratch, "generated/explain/get-users.md")
    expect(outcome.writtenTo).toBe(written)
    expect(await readFile(written, "utf8")).toContain("getUsers")
  })
})

describe("CL27 — an --output that cannot hold a file", () => {
  it("names the path and the remedy instead of surfacing the errno", async () => {
    await writeFile(resolve(scratch, "generated"), "not a directory\n", "utf8")

    const thrown = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      noRescan: true,
      outputPath: "generated/explain/get-user.md",
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("input-error")
    expect((thrown as Error).message).toContain(resolve(scratch, "generated/explain/get-user.md"))
    expect((thrown as Error).message).toContain("--output")
  })

  // No overwrite guard stands in front of this command, so the write is what answers.
  it("names a directory standing on the path itself", async () => {
    await mkdir(resolve(scratch, "generated"), { recursive: true })

    const thrown = await runExplain({
      cwd: scratch,
      argument: "ts:src/a.ts#getUser",
      noRescan: true,
      outputPath: "generated",
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe("input-error")
    expect((thrown as Error).message).toContain(resolve(scratch, "generated"))
    expect((thrown as Error).message).toContain("is a directory")
  })
})
