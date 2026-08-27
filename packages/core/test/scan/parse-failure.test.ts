import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BodyExtraction,
  ExtractionContext,
  ImportEdge,
  LangManifest,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scan } from "../../src"
import { buildDropCFilter } from "../../src/scan/drop-c"
import { runFilePipeline } from "../../src/scan/pipeline"
import { symbolId } from "../fixtures/ir"

/**
 * A `ParseError` marked `recoverable: false` withdraws its file.
 *
 * The field has been documented as "false → the core skips this file" since the plugin
 * types were written, and nothing read it: the only signal that withdrew a file was
 * `ParseResult.tree === null`, which a plugin sets separately. A plugin following the
 * documented contract — return the tree you managed to build, mark the error
 * non-recoverable to say "do not use this" — got its file processed normally, with no
 * error and no warning.
 *
 * `@aburi/lang-typescript` never noticed because the one `recoverable: false` it emits is
 * paired with a null tree, so the real gate fired anyway. The stub plugin here separates
 * the two signals, which is the whole point: a plugin that reasons from the type doc rather
 * than from that coincidence must get the behaviour it asked for.
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
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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

/** What `parseFile` returns for the file named by `on`; every other file parses cleanly. */
interface ParseSpec {
  on: string
  tree?: OpaqueAstNode | null
  errors?: readonly ParseError[]
  imports?: readonly ImportEdge[]
}

interface Reached {
  extractSymbols: string[]
  walkBody: string[]
  normalizeAst: string[]
}

function stubLanguage(spec: ParseSpec, reached: Reached): LanguagePlugin {
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
      const healthy = {
        tree: { path: file.path } as unknown as OpaqueAstNode,
        errors: [] as ParseError[],
        imports: [] as ImportEdge[],
      }
      if (file.path !== spec.on) return healthy
      return {
        tree: spec.tree === undefined ? healthy.tree : spec.tree,
        errors: [...(spec.errors ?? [])],
        imports: [...(spec.imports ?? [])],
      }
    },
    extractSymbols: (tree: OpaqueAstNode, ctx: ExtractionContext) => {
      reached.extractSymbols.push(ctx.file.path)
      void tree
      return [candidate(ctx.file.path)]
    },
    walkBody: (
      symbol: SymbolCandidate<OpaqueAstNode>,
      ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => {
      reached.walkBody.push(ctx.file.path)
      void symbol
      return { rules: [], calls: [] }
    },
    normalizeAst: (symbol: SymbolCandidate<OpaqueAstNode>) => {
      reached.normalizeAst.push(symbol.source.file)
      return "stub-ast"
    },
  }
  return plugin as unknown as LanguagePlugin
}

function noReach(): Reached {
  return { extractSymbols: [], walkBody: [], normalizeAst: [] }
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function nonRecoverable(message: string, line = 3, column = 7): ParseError {
  return { message, line, column, recoverable: false }
}

function edge(source: string): ImportEdge {
  return { source, symbols: ["X"], line: 1, dynamic: false }
}

describe("runFilePipeline — a non-recoverable parse error withdraws the file", () => {
  const file: SourceFile = { path: "bad.stub", content: "bad" }

  async function run(spec: Omit<ParseSpec, "on">, reached = noReach()) {
    const result = await runFilePipeline({
      file,
      language: stubLanguage({ on: file.path, ...spec }, reached),
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      config: {},
      dropCFilter: buildDropCFilter({ pluginDropCallees: [] }),
      log: silent,
    })
    return { result, reached }
  }

  it("flags a tree that came back with a non-recoverable error", async () => {
    const errors = [nonRecoverable("unterminated string")]
    const { result } = await run({ errors, imports: [edge("./x")] })
    expect(result.terminalParseFailure).toBe(true)
    expect(result.symbols).toEqual([])
    expect(result.parseTimeout).toBeNull()
    // Kept for the same reason the null-tree path keeps them: the file told us truthfully
    // what it imports even though its contents are unusable.
    expect(result.imports).toEqual([edge("./x")])
    expect(result.parseErrors).toEqual(errors)
  })

  it("asks the plugin nothing else about the file", async () => {
    const { reached } = await run({ errors: [nonRecoverable("unterminated string")] })
    expect(reached).toEqual(noReach())
  })

  it("keeps a file whose errors are all recoverable", async () => {
    const errors: ParseError[] = [{ message: "stray token", line: 1, column: 1, recoverable: true }]
    const { result, reached } = await run({ errors })
    expect(result.terminalParseFailure).toBe(false)
    expect(result.symbols).toHaveLength(1)
    expect(reached.extractSymbols).toEqual(["bad.stub"])
    expect(result.parseErrors).toEqual(errors)
  })

  it("withdraws when one error among several is non-recoverable", async () => {
    const { result } = await run({
      errors: [
        { message: "stray token", line: 1, column: 1, recoverable: true },
        nonRecoverable("unterminated string"),
      ],
    })
    expect(result.terminalParseFailure).toBe(true)
  })

  it("still withdraws a null tree that came back with no errors at all", async () => {
    const { result, reached } = await run({ tree: null, errors: [] })
    expect(result.terminalParseFailure).toBe(true)
    expect(reached).toEqual(noReach())
  })

  it("withdraws a null tree whose errors are all recoverable", async () => {
    // The tree is the whole signal here. An implementation that read only `errors` — or
    // only whether the list was empty — would extract this file from nothing.
    const { result, reached } = await run({
      tree: null,
      errors: [{ message: "stray token", line: 1, column: 1, recoverable: true }],
    })
    expect(result.terminalParseFailure).toBe(true)
    expect(reached).toEqual(noReach())
  })

  it("keeps a file whose plugin omitted `recoverable` altogether", async () => {
    // `recoverable` is required by the type, but a plugin is plain JavaScript loaded by ref
    // and can simply not write it. Read as falsiness, a missing key would withdraw every
    // file such a plugin reported any error on — silently, and at exit 0. Read literally,
    // the plugin gets what it had before the field was read at all.
    const errors = [{ message: "stray token", line: 1, column: 1 } as ParseError]
    const { result, reached } = await run({ errors })
    expect(result.terminalParseFailure).toBe(false)
    expect(reached.extractSymbols).toEqual(["bad.stub"])
  })
})

describe("scan — a withdrawn file is named, warned about, and subtracted once", () => {
  let workRoot: string

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "aburi-parse-failure-"))
    // One file either side of the broken one in discovery order, so a withdrawal that took
    // the rest of the run with it would be visible in both directions.
    await writeFile(join(workRoot, "a.stub"), "a", "utf8")
    await writeFile(join(workRoot, "bad.stub"), "bad", "utf8")
    await writeFile(join(workRoot, "c.stub"), "c", "utf8")
  })

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true })
  })

  function collectingLogger(warned: string[]): Logger {
    return { ...silent, warn: (message: string) => warned.push(message) }
  }

  async function runScanWith(spec: Omit<ParseSpec, "on">, warned: string[] = []) {
    const result = await scan({
      workspaceRoot: workRoot,
      config: {},
      languages: [stubLanguage({ on: "bad.stub", ...spec }, noReach())],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      logger: collectingLogger(warned),
    })
    return { result, warned }
  }

  it("names it in skipped, quoting the error that refused it", async () => {
    const { result } = await runScanWith({
      errors: [nonRecoverable("unterminated string", 12, 4)],
    })
    expect(result.skipped).toEqual([
      {
        path: "bad.stub",
        reason: "parse-failed",
        detail: "parse reported a non-recoverable error at 12:4 — unterminated string",
      },
    ])
  })

  it("picks the refusing error out of a list that starts with a recoverable one", async () => {
    // The detail names the error as non-recoverable, so quoting whichever came first would
    // put that label on an error that said the opposite.
    const { result } = await runScanWith({
      errors: [
        { message: "stray token", line: 1, column: 1, recoverable: true },
        nonRecoverable("unterminated string", 12, 4),
      ],
    })
    expect(result.skipped[0]?.detail).toBe(
      "parse reported a non-recoverable error at 12:4 — unterminated string",
    )
  })

  it("names a missing tree for what it is when no error explains it", async () => {
    const { result } = await runScanWith({ tree: null, errors: [] })
    expect(result.skipped).toEqual([
      {
        path: "bad.stub",
        reason: "parse-failed",
        detail: "the language plugin returned no tree",
      },
    ])
  })

  it("quotes a recoverable error beside the missing tree rather than dropping it", async () => {
    // This file is excluded from the CLI's recoverable-error count by construction, so the
    // skip detail is the last place the position it collapsed at can be read.
    const { result } = await runScanWith({
      tree: null,
      errors: [{ message: "stray token", line: 8, column: 2, recoverable: true }],
    })
    expect(result.skipped[0]?.detail).toBe(
      "the language plugin returned no tree; first error at 8:2 — stray token",
    )
  })

  it("warns once, with the same sentence", async () => {
    const { warned } = await runScanWith({
      errors: [nonRecoverable("unterminated string", 12, 4)],
    })
    expect(warned).toEqual([
      "Skipped bad.stub: parse reported a non-recoverable error at 12:4 — unterminated string",
    ])
  })

  it("subtracts it from parsedFiles exactly once", async () => {
    // The regression this pins is arithmetic: a withdrawn file is netted out by the
    // `skipped` list it now appears in, so a counter subtracting it a second time would
    // report two files lost for one.
    const { result } = await runScanWith({ errors: [nonRecoverable("unterminated string")] })
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(2)
  })

  it("still reports its parse errors, which are diagnostic rather than IR", async () => {
    const errors = [nonRecoverable("unterminated string")]
    const { result } = await runScanWith({ errors })
    expect(result.parseErrors).toEqual([{ file: "bad.stub", errors }])
  })

  it("leaves the files either side of it in the IR", async () => {
    const { result } = await runScanWith({ errors: [nonRecoverable("unterminated string")] })
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("records no extraction failure, because nothing threw", async () => {
    const { result } = await runScanWith({ errors: [nonRecoverable("unterminated string")] })
    expect(result.extractionFailures).toEqual([])
  })

  it("counts one file lost per reason when several reasons meet in one run", async () => {
    // The PR that added `parse-failed` rewrote the `parsedFiles` expression itself, so the
    // arithmetic is worth pinning where every kind of loss is present at once: a discovery
    // skip (which is added to `totalFiles` rather than netted out), a withdrawal, a throw,
    // and one healthy file.
    await writeFile(join(workRoot, "big.stub"), "x".repeat(2000), "utf8")
    await writeFile(join(workRoot, "boom.stub"), "boom", "utf8")
    await rm(join(workRoot, "c.stub"))

    const language = stubLanguage(
      { on: "bad.stub", errors: [nonRecoverable("refused")] },
      noReach(),
    )
    const throwing = {
      ...language,
      parseFile: async (file: SourceFile) => {
        if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
        return language.parseFile(file)
      },
    } as unknown as LanguagePlugin

    const result = await scan({
      workspaceRoot: workRoot,
      config: { maxFileSizeBytes: 1024 },
      languages: [throwing],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      logger: silent,
    })

    expect(result.ir.stats.totalFiles).toBe(4)
    expect(result.ir.stats.parsedFiles).toBe(1)
    expect(result.skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "parse-failed"],
      ["big.stub", "over-size"],
      ["boom.stub", "extraction-failed"],
    ])
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub"])
  })

  it("leaves a healthy workspace with an empty skip list", async () => {
    const { result, warned } = await runScanWith({
      errors: [{ message: "stray token", line: 1, column: 1, recoverable: true }],
    })
    expect(result.skipped).toEqual([])
    expect(warned).toEqual([])
    expect(result.ir.stats.parsedFiles).toBe(3)
  })
})
