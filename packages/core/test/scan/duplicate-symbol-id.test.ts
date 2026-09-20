import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopRegistry } from "@aburi/test-support"
import type {
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkIRIntegrity, scan } from "../../src"
import { symbolId } from "../fixtures/ir"
import { capturingLogger, stubLanguagePlugin } from "../fixtures/plugins"

/**
 * Two Symbols under one id cost their file, not the run.
 *
 * `lang-plugin.md` §7.2 has said one file's bug does not halt IR generation since before
 * there was a `try` in the scan, and every plugin fault honoured it but this one: invariant
 * #1 was decided by `assertIRIntegrity` over the assembled document, after every file had
 * been extracted, so a duplicate id threw and the run produced nothing at all. The report was
 * `ls: cannot access 'out'` rather than a thinner IR.
 *
 * The check now runs per file, where the file can still be withdrawn and named. The
 * document-wide one stays where it was, as the backstop it was meant to be.
 */

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

/** A plugin whose candidates for a file are whatever `emit` says, by path. */
function stubLanguage(
  emit: (path: string) => readonly SymbolCandidate<OpaqueAstNode>[],
): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (file: SourceFile): Promise<ParseResult> => ({
      tree: { path: file.path } as unknown as OpaqueAstNode,
      errors: [],
      imports: [],
    }),
    extractSymbols: (_tree, ctx) => [...emit(ctx.file.path)],
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

let workRoot: string

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "aburi-duplicate-symbol-id-"))
  // A file either side of the offending one in discovery order, so a check that withdrew the
  // run rather than the file would be visible in both directions.
  await writeFile(join(workRoot, "a.stub"), "a", "utf8")
  await writeFile(join(workRoot, "bad.stub"), "bad", "utf8")
  await writeFile(join(workRoot, "c.stub"), "c", "utf8")
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function run(emit: (path: string) => readonly SymbolCandidate<OpaqueAstNode>[]) {
  const { logger, warnings } = capturingLogger()
  const result = await scan({
    workspaceRoot: workRoot,
    config: {},
    languages: [stubLanguage(emit)],
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
    // The point of withdrawing rather than de-duplicating: the backstop has nothing to say,
    // and it is reached — `scan` runs it over every document it returns.
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
    // `extraction-failed` is the reason, so the exit code follows the existing path and a run
    // that hit this is not green.
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.ir.stats.totalFiles).toBe(3)
  })

  it("keeps the twins together — neither is silently the winner", async () => {
    // Picking one would be the failure this is about: the plugin reported nothing that
    // separates them, so core has no basis to choose, and a document carrying one of two
    // declarations under a shared name is worse than one that says the file was withdrawn.
    const { result } = await run(TWINS_IN_ONE_FILE)
    expect(result.ir.symbols.some((s) => s.id === "stub:bad.stub#same")).toBe(false)
  })
})

describe("an id an earlier file already contributed withdraws the later file", () => {
  it("keeps the file that claimed the id first", async () => {
    const { result } = await run(ID_FROM_ANOTHER_FILE)
    expect(result.ir.symbols.map((s) => s.id)).toEqual(["stub:a.stub#only", "stub:bad.stub#only"])
  })

  it("names the file that already had it, which the id alone does not", async () => {
    const { result } = await run(ID_FROM_ANOTHER_FILE)
    expect(result.skipped).toEqual([
      {
        path: "c.stub",
        reason: "extraction-failed",
        detail: expect.stringContaining(
          'Symbol id "stub:a.stub#only" was already contributed by a.stub',
        ),
      },
    ])
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
