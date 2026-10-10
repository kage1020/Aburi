import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type {
  ExtractionContext,
  IR,
  LanguagePlugin,
  OpaqueAstNode,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkIRIntegrity, makeLanguageId, scan } from "../../src"
import { spend } from "../fixtures/clock"
import { stubCandidate, stubLanguagePlugin } from "../fixtures/plugins"

function candidate(file: string): SymbolCandidate<OpaqueAstNode> {
  return stubCandidate(file.replace(/[^A-Za-z0-9]/g, "_"), { file })
}

/** Refuses `refused.stub`, throws on `boom.stub`, parses everything else. */
function stubLanguage(): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (file: SourceFile): Promise<ParseResult> => {
      if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
      // Spent, not mocked — see `spend`.
      if (file.path === "slow.stub") spend(250)
      const errors: ParseError[] =
        file.path === "refused.stub"
          ? [{ message: "wrong dialect", line: 1, column: 1, recoverable: false }]
          : []
      return { tree: { path: file.path } as unknown as OpaqueAstNode, errors, imports: [] }
    },
    extractSymbols: (_tree: OpaqueAstNode, ctx: ExtractionContext) => [candidate(ctx.file.path)],
  })
}

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-skipped-files-"))
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function runScan(config: Parameters<typeof scan>[0]["config"] = {}) {
  return scan({
    workspaceRoot: workRoot,
    config,
    languages: [stubLanguage()],
    frameworks: [],
    effects: [],
    registry: noopRegistry,
  })
}

describe("stats.skippedFiles — the Document names what the scan lost", () => {
  it("lists every reason in one array, discovery-time and extraction-time alike", async () => {
    await writeFile(join(workRoot, "ok.stub"), "ok", "utf8")
    await writeFile(join(workRoot, "big.stub"), "x".repeat(2000), "utf8")
    await writeFile(join(workRoot, "boom.stub"), "boom", "utf8")
    await writeFile(join(workRoot, "refused.stub"), "refused", "utf8")

    const result = await runScan({ maxFileSizeBytes: 1024 })

    expect(result.ir.stats.skippedFiles).toEqual([
      { path: "big.stub", reason: "over-size" },
      { path: "boom.stub", reason: "extraction-failed" },
      { path: "refused.stub", reason: "parse-failed" },
    ])
  })

  it("agrees with the counters it sits beside", async () => {
    await writeFile(join(workRoot, "ok.stub"), "ok", "utf8")
    await writeFile(join(workRoot, "refused.stub"), "refused", "utf8")

    const { stats } = (await runScan()).ir
    expect(stats.totalFiles).toBe(2)
    expect(stats.parsedFiles).toBe(1)
    expect(stats.skippedFiles).toHaveLength(stats.totalFiles - stats.parsedFiles)
  })

  it("passes its own integrity check, sort order included", async () => {
    for (const name of ["Z.stub", "a.stub", "\u00e9.stub", "b.stub"]) {
      await writeFile(join(workRoot, name), "x".repeat(2000), "utf8")
    }
    const { ir } = await runScan({ maxFileSizeBytes: 1024 })
    expect(ir.stats.skippedFiles).toHaveLength(4)
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("names a file no Symbol in it could have named", async () => {
    await writeFile(join(workRoot, "ok.stub"), "ok", "utf8")
    await writeFile(join(workRoot, "od#d.stub"), "odd", "utf8")

    const result = await runScan()

    expect(result.ir.stats.totalFiles).toBe(2)
    expect(result.ir.stats.parsedFiles).toBe(1)
    expect(result.ir.stats.skippedFiles).toEqual([{ path: "od#d.stub", reason: "unroutable" }])
    expect(checkIRIntegrity(result.ir)).toEqual([])
    // And the rest of the workspace is in the document, which is the whole point.
    expect(result.ir.symbols).toHaveLength(1)
  })

  it("omits the key entirely when nothing was lost", async () => {
    await writeFile(join(workRoot, "ok.stub"), "ok", "utf8")
    const { stats } = (await runScan()).ir
    expect("skippedFiles" in stats).toBe(false)
  })

  it("says how long a timed-out file ran and what it was given", async () => {
    await writeFile(join(workRoot, "slow.stub"), "slow", "utf8")
    const result = await runScan({ parseTimeoutMs: 100 })

    const skipped = result.skipped[0]
    expect(skipped?.reason).toBe("parse-timeout")
    const spent = /^extraction reached (\d+)ms, exceeding parseTimeoutMs \(100ms\)$/.exec(
      skipped?.detail ?? "",
    )
    expect(spent).not.toBeNull()
    expect(Number(spent?.[1])).toBeGreaterThanOrEqual(250)
    // And still not in the Document: those milliseconds are how loaded the machine was.
    expect(result.ir.stats.skippedFiles).toEqual([{ path: "slow.stub", reason: "parse-timeout" }])
  })

  it("carries no detail, so the bytes do not depend on where the repository sits", async () => {
    await writeFile(join(workRoot, "refused.stub"), "refused", "utf8")
    const result = await runScan()

    expect(result.skipped[0]?.detail).toContain("wrong dialect")
    expect(result.ir.stats.skippedFiles).toEqual([{ path: "refused.stub", reason: "parse-failed" }])
    for (const entry of result.ir.stats.skippedFiles ?? []) {
      expect(Object.keys(entry).sort()).toEqual(["path", "reason"])
    }
  })
})

describe("integrity #21 — the list accounts for every unparsed file", () => {
  function documentWith(stats: Partial<IR["stats"]>): IR {
    return {
      $schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json",
      generator: { name: "aburi", version: "0.0.0", plugins: [] },
      workspace: { root: ".", managers: [], languages: [makeLanguageId("stub")] },
      components: [],
      symbols: [],
      dependencies: [],
      stats: {
        totalFiles: 3,
        parsedFiles: 1,
        keptSymbols: 0,
        droppedSymbols: 0,
        effectPropagation: {
          sccCount: 0,
          maxSccSize: 0,
          propagatedEffectCount: 0,
          symbolsWithPropagatedEffects: 0,
        },
        ...stats,
      },
    }
  }

  const of21 = (ir: IR) => checkIRIntegrity(ir).filter((v) => v.invariant === 21)

  it("passes when the length matches totalFiles - parsedFiles", () => {
    const ir = documentWith({
      skippedFiles: [
        { path: "a.stub", reason: "over-size" },
        { path: "b.stub", reason: "parse-failed" },
      ],
    })
    expect(of21(ir)).toEqual([])
  })

  it("holds the paths to the rules every other path-bearing array obeys", () => {
    expect(
      checkIRIntegrity(
        documentWith({
          skippedFiles: [
            { path: "b.stub", reason: "over-size" },
            { path: "a.stub", reason: "parse-failed" },
          ],
        }),
      ).map((v) => v.invariant),
    ).toContain(11)
    expect(
      checkIRIntegrity(
        documentWith({
          skippedFiles: [
            { path: "/abs/a.stub", reason: "over-size" },
            { path: "b.stub", reason: "parse-failed" },
          ],
        }),
      ).map((v) => v.invariant),
    ).toContain(10)
    expect(
      checkIRIntegrity(
        documentWith({
          skippedFiles: [
            { path: "cafe\u0301.stub", reason: "over-size" },
            { path: "z.stub", reason: "parse-failed" },
          ],
        }),
      ).map((v) => v.invariant),
    ).toContain(19)
  })

  it("fires when a file went missing from the list", () => {
    const ir = documentWith({ skippedFiles: [{ path: "a.stub", reason: "over-size" }] })
    expect(of21(ir)[0]?.message).toContain("names 1 file(s) but totalFiles - parsedFiles is 2")
  })

  it("fires when one file is named twice", () => {
    const ir = documentWith({
      skippedFiles: [
        { path: "a.stub", reason: "over-size" },
        { path: "a.stub", reason: "parse-failed" },
      ],
    })
    expect(of21(ir)[0]?.message).toContain("more than once")
  })

  it("stays silent for a document that omits the key, however many files it lost", () => {
    expect(of21(documentWith({}))).toEqual([])
  })

  it("fires when more files were parsed than were found, list or no list", () => {
    expect(of21(documentWith({ totalFiles: 1, parsedFiles: 2 }))[0]?.message).toContain(
      "cannot parse more files than it found",
    )
    expect(
      of21(
        documentWith({
          totalFiles: 1,
          parsedFiles: 2,
          skippedFiles: [{ path: "a.stub", reason: "over-size" }],
        }),
      ).map((v) => v.message),
    ).toHaveLength(2)
  })

  it("stays silent when every file found was parsed", () => {
    expect(of21(documentWith({ totalFiles: 2, parsedFiles: 2 }))).toEqual([])
  })
})
