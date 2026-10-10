import { recordingLogger } from "@aburi/test-support"
import type { ParseResult, SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { scanStubs, stubCandidate, stubLanguagePlugin, useStubWorkspace } from "../fixtures/plugins"

type Emit = (path: string) => readonly SymbolCandidate[]

function declared(file: string, name: string, line: number): SymbolCandidate {
  return stubCandidate(name, {
    file,
    source: { file, startLine: line, endLine: line + 1, startColumn: null, endColumn: null },
  })
}

const ONE_EACH: Emit = (path) => [declared(path, "only", 1)]

/** One healthy Symbol per file, and two under one id in `bad.stub`. */
const TWINS_IN_BAD: Emit = (path) =>
  path === "bad.stub" ? [declared(path, "same", 3), declared(path, "same", 9)] : ONE_EACH(path)

const workspace = useStubWorkspace("duplicate-symbol-id")

async function run(
  emit: Emit,
  language: { parseErrorsFor?: (path: string) => ParseResult["errors"]; dropLine?: number } = {},
) {
  const logger = recordingLogger()
  const result = await scanStubs(workspace.root, {
    languages: [
      stubLanguagePlugin({
        parseFile: async (file) => ({
          tree: {},
          errors: [...(language.parseErrorsFor?.(file.path) ?? [])],
          imports: [],
        }),
        extractSymbols: (_tree, ctx) => [...emit(ctx.file.path)],
        symbolDropHint: (symbol) =>
          symbol.source.startLine === language.dropLine
            ? { reason: "stub dropped it", category: "B" }
            : null,
      }),
    ],
    logger,
  })
  return { result, warnings: logger.warnings }
}

describe("two Symbols under one id withdraw their file", () => {
  it("hands back a document holding every other file", async () => {
    const { result } = await run(TWINS_IN_BAD)
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("names the file and both declarations, since the id names neither", async () => {
    const { result } = await run(TWINS_IN_BAD)
    expect(result.skipped).toEqual([
      {
        path: "bad.stub",
        reason: "extraction-failed",
        detail: expect.stringContaining(
          'two Symbols share the id "stub:bad.stub#same" (lines 3 and 9)',
        ),
      },
    ])
  })

  it("codes the failure, so a reader can tell it from a plugin that crashed", async () => {
    const { result } = await run(TWINS_IN_BAD)
    expect(result.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["bad.stub", "duplicate-symbol-id"],
    ])
  })

  it("warns with the file, on the channel every other withdrawal uses", async () => {
    const { warnings } = await run(TWINS_IN_BAD)
    expect(warnings).toEqual([expect.stringMatching(/^Skipped bad\.stub: /)])
  })

  it("excludes the file from parsedFiles while it still counts as discovered", async () => {
    const { result } = await run(TWINS_IN_BAD)
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.ir.stats.totalFiles).toBe(3)
  })

  it("names the first two of three declarations sharing the id", async () => {
    const { result } = await run((path) =>
      path === "bad.stub"
        ? [declared(path, "same", 3), declared(path, "same", 9), declared(path, "same", 14)]
        : ONE_EACH(path),
    )
    expect(result.skipped[0]?.detail).toContain(
      'two Symbols share the id "stub:bad.stub#same" (lines 3 and 9)',
    )
  })

  it("withdraws the file even when a drop hint took one of the two, because a drop keeps the id", async () => {
    const { result } = await run(TWINS_IN_BAD, { dropLine: 9 })
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "extraction-failed"],
    ])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("keeps the file's recoverable parse errors beside the withdrawal", async () => {
    const error = { message: "unexpected token", line: 3, column: 7, recoverable: true }
    const { result } = await run(TWINS_IN_BAD, {
      parseErrorsFor: (path) => (path === "bad.stub" ? [error] : []),
    })
    expect(result.parseErrors).toEqual([{ file: "bad.stub", errors: [error] }])
    expect(result.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["bad.stub", "duplicate-symbol-id"],
    ])
  })
})

describe("an id naming another file withdraws the file that wrote it", () => {
  it.each<[string, string, string, string[]]>([
    ["after", "c.stub", "a.stub", ["stub:a.stub#only", "stub:bad.stub#only"]],
    ["before", "a.stub", "c.stub", ["stub:bad.stub#only", "stub:c.stub#only"]],
  ])("blames the offender when it comes %s the file it names", async (_order, offender, named, kept) => {
    const { result } = await run((path) =>
      path === offender ? [declared(named, "only", 1)] : ONE_EACH(path),
    )
    expect(result.skipped).toEqual([
      {
        path: offender,
        reason: "extraction-failed",
        detail: expect.stringContaining(`Symbol id "stub:${named}#only" names ${named}`),
      },
    ])
    expect(result.ir.symbols.map((s) => s.id)).toEqual(kept)
  })

  it("withdraws every offending file, in discovery order", async () => {
    const { result } = await run((path) => {
      if (path === "a.stub") return [declared("c.stub", "only", 1)]
      return TWINS_IN_BAD(path)
    })
    expect(result.skipped.map((f) => f.path)).toEqual(["a.stub", "bad.stub"])
    expect(result.extractionFailures.map((f) => f.file)).toEqual(["a.stub", "bad.stub"])
    expect(result.ir.symbols.map((s) => s.id)).toEqual(["stub:c.stub#only"])
  })
})

describe("a workspace with no collision", () => {
  it("withdraws nothing and reports nothing", async () => {
    const { result, warnings } = await run(ONE_EACH)
    expect(result.ir.symbols).toHaveLength(3)
    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
    expect(warnings).toEqual([])
  })
})
