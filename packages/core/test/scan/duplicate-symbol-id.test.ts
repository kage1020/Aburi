import { noopRegistry } from "@aburi/test-support"
import type {
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity, scan } from "../../src"
import { symbolId } from "../fixtures/ir"
import { capturingLogger, stubLanguagePlugin, useStubWorkspace } from "../fixtures/plugins"

function candidate(file: string, name: string, line: number): SymbolCandidate<OpaqueAstNode> {
  return {
    id: symbolId(`stub:${file}#${name}`),
    kind: "function",
    extKind: null,
    name,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file, startLine: line, endLine: line + 1, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

function stubLanguage(
  emit: (path: string) => readonly SymbolCandidate<OpaqueAstNode>[],
  parseErrorsFor: (path: string) => ParseResult["errors"] = () => [],
  dropWhen: (symbol: SymbolCandidate<OpaqueAstNode>) => boolean = () => false,
): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (file: SourceFile): Promise<ParseResult> => ({
      tree: { path: file.path } as unknown as OpaqueAstNode,
      errors: [...parseErrorsFor(file.path)],
      imports: [],
    }),
    extractSymbols: (_tree, ctx) => [...emit(ctx.file.path)],
    symbolDropHint: (symbol) =>
      dropWhen(symbol) ? { reason: "stub dropped it", category: "B" } : null,
  })
}

/** One healthy Symbol per file, and two under one id in `bad.stub`. */
const TWINS_IN_ONE_FILE = (path: string): readonly SymbolCandidate<OpaqueAstNode>[] =>
  path === "bad.stub"
    ? [candidate(path, "same", 3), candidate(path, "same", 9)]
    : [candidate(path, "only", 1)]

/** `c.stub` claims an id whose path names `a.stub`, which only a broken plugin can do. */
const ID_FROM_ANOTHER_FILE = (path: string): readonly SymbolCandidate<OpaqueAstNode>[] =>
  path === "c.stub" ? [candidate("a.stub", "only", 1)] : [candidate(path, "only", 1)]

const ID_FROM_ANOTHER_FILE_REVERSED = (path: string): readonly SymbolCandidate<OpaqueAstNode>[] =>
  path === "a.stub" ? [candidate("c.stub", "only", 1)] : [candidate(path, "only", 1)]

/** Two files, each with its own fault, so the loop has to carry on past the first. */
const TWO_OFFENDERS = (path: string): readonly SymbolCandidate<OpaqueAstNode>[] => {
  if (path === "a.stub") return [candidate("c.stub", "only", 1)]
  if (path === "bad.stub") return [candidate(path, "same", 3), candidate(path, "same", 9)]
  return [candidate(path, "only", 1)]
}

/** Three under one id, to pin which two declarations the message names. */
const TRIPLETS = (path: string): readonly SymbolCandidate<OpaqueAstNode>[] =>
  path === "bad.stub"
    ? [candidate(path, "same", 3), candidate(path, "same", 9), candidate(path, "same", 14)]
    : [candidate(path, "only", 1)]

const workspace = useStubWorkspace("duplicate-symbol-id")

async function run(
  emit: (path: string) => readonly SymbolCandidate<OpaqueAstNode>[],
  parseErrorsFor?: (path: string) => ParseResult["errors"],
  dropWhen?: (symbol: SymbolCandidate<OpaqueAstNode>) => boolean,
) {
  const { logger, warnings } = capturingLogger()
  const result = await scan({
    workspaceRoot: workspace.root,
    config: {},
    languages: [stubLanguage(emit, parseErrorsFor, dropWhen)],
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    components: [],
    logger,
  })
  return { result, warnings }
}

describe("two Symbols under one id withdraw their file", () => {
  it("hands back a document, where the run used to produce none", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("leaves the document satisfying the invariant it was withdrawn for", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(checkIRIntegrity(result.ir)).toEqual([])
  })

  it("names the file and both declarations, since the id names neither", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE)
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
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.extractionFailures.map((f) => [f.file, f.code])).toEqual([
      ["bad.stub", "duplicate-symbol-id"],
    ])
  })

  it("warns with the file, on the channel every other withdrawal uses", async () => {
    const { warnings } = await run(TWINS_IN_ONE_FILE)
    expect(warnings.some((w) => w.startsWith("Skipped bad.stub:"))).toBe(true)
  })

  it("excludes the file from parsedFiles while it still counts as discovered", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.ir.stats.totalFiles).toBe(3)
  })

  it("keeps the twins together — neither is silently the winner", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.ir.symbols.some((s) => s.id === "stub:bad.stub#same")).toBe(false)
  })
})

describe("an id naming another file withdraws the file that wrote it", () => {
  it("withdraws the offender, not the file the id names", async () => {
    const { result } = await run(ID_FROM_ANOTHER_FILE)
    expect(result.skipped).toEqual([
      {
        path: "c.stub",
        reason: "extraction-failed",
        detail: expect.stringContaining('Symbol id "stub:a.stub#only" names a.stub'),
      },
    ])
    expect(result.ir.symbols.map((s) => s.id)).toEqual(["stub:a.stub#only", "stub:bad.stub#only"])
  })

  it("blames the same file when the offender comes first in discovery order", async () => {
    const { result } = await run(ID_FROM_ANOTHER_FILE_REVERSED)
    expect(result.skipped).toEqual([
      {
        path: "a.stub",
        reason: "extraction-failed",
        detail: expect.stringContaining('Symbol id "stub:c.stub#only" names c.stub'),
      },
    ])
  })

  it("leaves no Symbol behind claiming a file the document says was withdrawn", async () => {
    const { result } = await run(ID_FROM_ANOTHER_FILE_REVERSED)
    const withdrawn = new Set(result.skipped.map((f) => f.path))
    expect(result.ir.symbols.filter((s) => withdrawn.has(s.source.file))).toEqual([])
    expect(checkIRIntegrity(result.ir)).toEqual([])
  })
})

describe("more than one offending file in a run", () => {
  it("withdraws both and keeps them in discovery order", async () => {
    const { result } = await run(TWO_OFFENDERS)
    expect(result.skipped.map((f) => f.path)).toEqual(["a.stub", "bad.stub"])
    expect(result.extractionFailures.map((f) => f.file)).toEqual(["a.stub", "bad.stub"])
    expect(result.ir.symbols.map((s) => s.id)).toEqual(["stub:c.stub#only"])
  })
})

describe("three Symbols under one id", () => {
  it("names the first two declarations, which are the two it has", async () => {
    const { result } = await run(TRIPLETS)
    expect(result.skipped[0]?.detail).toContain(
      'two Symbols share the id "stub:bad.stub#same" (lines 3 and 9)',
    )
  })
})

describe("a workspace with no collision is untouched", () => {
  it("withdraws nothing and reports nothing", async () => {
    const { result, warnings } = await run((path) => [candidate(path, "only", 1)])
    expect(result.ir.symbols).toHaveLength(3)
    expect(result.skipped).toEqual([])
    expect(result.extractionFailures).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe("a withdrawn file's recoverable parse errors", () => {
  /** One recoverable error on `bad.stub`, the file the duplicate id also withdraws. */
  const RECOVERABLE_ON_BAD = (path: string): ParseResult["errors"] =>
    path === "bad.stub"
      ? [{ message: "unexpected token", line: 3, column: 7, recoverable: true }]
      : []

  it("survives the withdrawal, unlike a file a plugin threw on", async () => {
    const { result } = await run(TWINS_IN_ONE_FILE, RECOVERABLE_ON_BAD)
    expect(result.parseErrors).toEqual([
      {
        file: "bad.stub",
        errors: [{ message: "unexpected token", line: 3, column: 7, recoverable: true }],
      },
    ])
  })

  it("is kept beside the withdrawal rather than in place of it", async () => {
    // Both accounts, not one: the parse fault and the id fault are separate things to fix.
    const { result } = await run(TWINS_IN_ONE_FILE, RECOVERABLE_ON_BAD)
    expect(result.skipped.map((s) => s.path)).toEqual(["bad.stub"])
    expect(result.extractionFailures.map((f) => f.code)).toEqual(["duplicate-symbol-id"])
  })
})

describe("a dropped Symbol colliding with a kept one", () => {
  it("still withdraws the file, because a drop keeps the id", async () => {
    const { result } = await run(
      TWINS_IN_ONE_FILE,
      undefined,
      (symbol) => symbol.source.startLine === 9,
    )
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "extraction-failed"],
    ])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })
})
