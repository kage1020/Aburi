import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  ExtractionContext,
  ImportEdge,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseError,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scan, VocabCheck } from "../../src"
import { buildDropCFilter } from "../../src/scan/drop-c"
import { runFilePipeline } from "../../src/scan/pipeline"
import { stubCandidate, stubLanguagePlugin } from "../fixtures/plugins"

function candidate(file: string): SymbolCandidate<OpaqueAstNode> {
  return stubCandidate(file.replace(/[^A-Za-z0-9]/g, "_"), { file })
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
  return stubLanguagePlugin({
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
  })
}

function noReach(): Reached {
  return { extractSymbols: [], walkBody: [], normalizeAst: [] }
}

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
      vocab: new VocabCheck(noopRegistry, true),
      config: {},
      dropCFilter: buildDropCFilter({ pluginDropCallees: [] }),
      component: null,
      log: silentLogger,
      treeReleaseFailures: [],
    })
    return { result, reached }
  }

  it("reports a tree that came back with a non-recoverable error as withdrawn", async () => {
    const errors = [nonRecoverable("unterminated string")]
    const { result } = await run({ errors, imports: [edge("./x")] })
    expect(result.kind).toBe("parse-failed")
    if (result.kind !== "parse-failed") return
    expect(result.imports).toEqual([edge("./x")])
    expect(result.parseErrors).toEqual(errors)
    expect("symbols" in result).toBe(false)
    expect("timeout" in result).toBe(false)
  })

  it("asks the plugin nothing else about the file", async () => {
    const { reached } = await run({ errors: [nonRecoverable("unterminated string")] })
    expect(reached).toEqual(noReach())
  })

  it("keeps a file whose errors are all recoverable", async () => {
    const errors: ParseError[] = [{ message: "stray token", line: 1, column: 1, recoverable: true }]
    const { result, reached } = await run({ errors })
    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
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
    expect(result.kind).toBe("parse-failed")
  })

  it("still withdraws a null tree that came back with no errors at all", async () => {
    const { result, reached } = await run({ tree: null, errors: [] })
    expect(result.kind).toBe("parse-failed")
    expect(reached).toEqual(noReach())
  })

  it("withdraws a null tree whose errors are all recoverable", async () => {
    const { result, reached } = await run({
      tree: null,
      errors: [{ message: "stray token", line: 1, column: 1, recoverable: true }],
    })
    expect(result.kind).toBe("parse-failed")
    expect(reached).toEqual(noReach())
  })

  it("keeps a file whose plugin omitted `recoverable` altogether", async () => {
    const errors = [{ message: "stray token", line: 1, column: 1 } as ParseError]
    const { result, reached } = await run({ errors })
    expect(result.kind).toBe("extracted")
    expect(reached.extractSymbols).toEqual(["bad.stub"])
  })
})

describe("scan — a withdrawn file is named, warned about, and subtracted once", () => {
  let workRoot: string

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "aburi-parse-failure-"))
    await writeFile(join(workRoot, "a.stub"), "a", "utf8")
    await writeFile(join(workRoot, "bad.stub"), "bad", "utf8")
    await writeFile(join(workRoot, "c.stub"), "c", "utf8")
  })

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true })
  })

  function collectingLogger(warned: string[]): Logger {
    return { ...silentLogger, warn: (message: string) => warned.push(message) }
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
    await writeFile(join(workRoot, "big.stub"), "x".repeat(2000), "utf8")
    await writeFile(join(workRoot, "boom.stub"), "boom", "utf8")
    await rm(join(workRoot, "c.stub"))

    const language = stubLanguage(
      { on: "bad.stub", errors: [nonRecoverable("refused")] },
      noReach(),
    )
    const throwing: LanguagePlugin = {
      ...language,
      parseFile: async (file: SourceFile) => {
        if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
        return language.parseFile(file)
      },
    }

    const result = await scan({
      workspaceRoot: workRoot,
      config: { maxFileSizeBytes: 1024 },
      languages: [throwing],
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      logger: silentLogger,
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
