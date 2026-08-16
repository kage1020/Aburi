import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BodyExtraction,
  ExtractionContext,
  IR,
  LangManifest,
  LanguagePlugin,
  OpaqueAstNode,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkIRIntegrity, makeLanguageId, scan } from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * The Document records what the scan gave up on.
 *
 * Without it the only trace of a loss was `totalFiles > parsedFiles`, which names no file
 * and is equally true of an over-size file, a timed-out one and a withdrawn one. A `diff`
 * against a document that lost a file therefore reported its Symbols as deliberately deleted
 * API, with a confident count and no way for the reader to tell.
 */

const noopRegistry: VocabRegistry = {
  findEffect: () => null,
  findExtKind: () => null,
  findFramework: () => null,
  findDerivedByOwner: () => null,
  isEffectOwnedBy: () => false,
  isExtKindOwnedBy: () => false,
  listEffects: () => [],
  listExtKinds: () => [],
  listFrameworks: () => [],
  listPlugins: () => [],
  assertEffectDeclared: () => {},
  assertExtKindDeclared: () => {},
}

function langManifest(): LangManifest {
  return {
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
}

function candidate(file: string): SymbolCandidate<OpaqueAstNode> {
  const base = file.replace(/[^A-Za-z0-9]/g, "_")
  return {
    id: symbolId(`stub:${file}#${base}`),
    kind: "function",
    extKind: null,
    name: base,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file, startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

/** Refuses `refused.stub`, throws on `boom.stub`, parses everything else. */
function stubLanguage(): LanguagePlugin {
  const plugin = {
    manifest: langManifest(),
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
    parseFile: async (file: SourceFile): Promise<ParseResult> => {
      if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
      const errors: ParseError[] =
        file.path === "refused.stub"
          ? [{ message: "wrong dialect", line: 1, column: 1, recoverable: false }]
          : []
      return { tree: { path: file.path } as unknown as OpaqueAstNode, errors, imports: [] }
    },
    extractSymbols: (_tree: OpaqueAstNode, ctx: ExtractionContext) => [candidate(ctx.file.path)],
    walkBody: (
      _symbol: SymbolCandidate<OpaqueAstNode>,
      _ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => ({ rules: [], calls: [] }),
    normalizeAst: () => "stub-ast",
  }
  return plugin as unknown as LanguagePlugin
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
    // `scan()` sorts with a raw `a.path < b.path` and `checkArraySortOrder` compares with
    // `compareCodeUnit`; a document that satisfies one and not the other would be written
    // and then refused on read.
    for (const name of ["Z.stub", "a.stub", "\u00e9.stub", "b.stub"]) {
      await writeFile(join(workRoot, name), "x".repeat(2000), "utf8")
    }
    const { ir } = await runScan({ maxFileSizeBytes: 1024 })
    expect(ir.stats.skippedFiles).toHaveLength(4)
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("omits the key entirely when nothing was lost", async () => {
    // Class B. `[]` would erase the distinction between "this run lost nothing" and "this
    // document predates the field", which is the one thing a reader of an old IR needs.
    await writeFile(join(workRoot, "ok.stub"), "ok", "utf8")
    const { stats } = (await runScan()).ir
    expect("skippedFiles" in stats).toBe(false)
  })

  it("carries no detail, so the bytes do not depend on where the repository sits", async () => {
    // The scan holds a detail per entry and the `unreadable` one is a Node error message
    // containing the absolute path. Serialising it would make two checkouts of the same
    // commit produce different documents.
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
      $schema: "https://aburi.dev/schema/aburi.ir.v1.json",
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
    // Unfiltered on purpose. #21 is not the only check this array joined, and a test that
    // filters to it would stay green with paths that are unsorted, absolute, or decomposed
    // — and the NFC one is load-bearing: an NFD spelling never matches
    // `symbols[].source.file`, so the lost file's Symbols go back to being confidently
    // reported as removed, which is the regression the array exists to prevent.
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
    // An IR written before the field existed cannot satisfy this and is not wrong for it.
    // Reporting a violation would make every archived document unreadable.
    expect(of21(documentWith({}))).toEqual([])
  })
})
