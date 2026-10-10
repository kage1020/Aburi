import { rm } from "node:fs/promises"
import { join } from "node:path"
import { recordingLogger } from "@aburi/test-support"
import type { ImportEdge, LanguagePlugin, ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  fileCandidate,
  runPipeline,
  scanStubs,
  stubLanguagePlugin,
  useStubWorkspace,
} from "../fixtures/plugins"

/** What `parseFile` hands back for `bad.stub`; every other file parses cleanly. */
interface BadParse {
  tree?: object | null
  errors?: readonly ParseError[]
  imports?: readonly ImportEdge[]
}

interface Reached {
  extractSymbols: string[]
  walkBody: string[]
  normalizeAst: string[]
}

function parsingBadAs(bad: BadParse, reached: Reached = noReach()): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (file) =>
      file.path === "bad.stub"
        ? {
            tree: bad.tree === undefined ? {} : bad.tree,
            errors: [...(bad.errors ?? [])],
            imports: [...(bad.imports ?? [])],
          }
        : { tree: {}, errors: [], imports: [] },
    extractSymbols: (_tree, ctx) => {
      reached.extractSymbols.push(ctx.file.path)
      return [fileCandidate(ctx.file.path)]
    },
    walkBody: (_symbol, ctx) => {
      reached.walkBody.push(ctx.file.path)
      return { rules: [], calls: [] }
    },
    normalizeAst: (symbol) => {
      reached.normalizeAst.push(symbol.source.file)
      return "stub-ast"
    },
  })
}

function noReach(): Reached {
  return { extractSymbols: [], walkBody: [], normalizeAst: [] }
}

function refused(message: string, line = 3, column = 7): ParseError {
  return { message, line, column, recoverable: false }
}

const STRAY: ParseError = { message: "stray token", line: 1, column: 1, recoverable: true }

describe("runFilePipeline — a refused parse withdraws the file", () => {
  async function run(bad: BadParse) {
    const reached = noReach()
    const result = await runPipeline({
      file: { path: "bad.stub", content: "bad" },
      language: parsingBadAs(bad, reached),
    })
    return { result, reached }
  }

  it("hands back the file's errors and import edges, and nothing it would have extracted", async () => {
    const errors = [refused("unterminated string")]
    const imports: ImportEdge[] = [{ source: "./x", symbols: ["X"], line: 1, dynamic: false }]
    const { result, reached } = await run({ errors, imports })

    expect(result).toEqual({ kind: "parse-failed", path: "bad.stub", parseErrors: errors, imports })
    expect(reached).toEqual(noReach())
  })

  it.each<[string, BadParse]>([
    [
      "one error among several is non-recoverable",
      { errors: [STRAY, refused("unterminated string")] },
    ],
    ["no tree came back, with no error at all", { tree: null, errors: [] }],
    ["no tree came back, with only recoverable errors", { tree: null, errors: [STRAY] }],
  ])("withdraws the file when %s", async (_label, bad) => {
    const { result, reached } = await run(bad)
    expect(result.kind).toBe("parse-failed")
    expect(reached).toEqual(noReach())
  })

  it.each<[string, ParseError]>([
    ["all recoverable", STRAY],
    ["silent about recoverability", { message: "stray token", line: 1, column: 1 } as ParseError],
  ])("extracts a file whose errors are %s, and keeps them", async (_label, error) => {
    const { result, reached } = await run({ errors: [error] })
    expect(result.kind === "extracted" && result.symbols).toHaveLength(1)
    expect(result.parseErrors).toEqual([error])
    expect(reached.extractSymbols).toEqual(["bad.stub"])
  })
})

describe("scan — a withdrawn file is named, warned about, and subtracted once", () => {
  const workspace = useStubWorkspace("parse-failure")

  async function run(bad: BadParse) {
    const logger = recordingLogger()
    const result = await scanStubs(workspace.root, { languages: [parsingBadAs(bad)], logger })
    return { result, warnings: logger.warnings }
  }

  it.each<[string, BadParse, string]>([
    [
      "the error that refused it",
      { errors: [refused("unterminated string", 12, 4)] },
      "parse reported a non-recoverable error at 12:4 — unterminated string",
    ],
    [
      "the refusing error out of a list that starts with a recoverable one",
      { errors: [STRAY, refused("unterminated string", 12, 4)] },
      "parse reported a non-recoverable error at 12:4 — unterminated string",
    ],
    [
      "a missing tree, when no error explains it",
      { tree: null, errors: [] },
      "the language plugin returned no tree",
    ],
    [
      "a missing tree beside the first recoverable error",
      { tree: null, errors: [{ ...STRAY, line: 8, column: 2 }] },
      "the language plugin returned no tree; first error at 8:2 — stray token",
    ],
  ])("skips it naming %s, and warns with the same sentence", async (_label, bad, detail) => {
    const { result, warnings } = await run(bad)
    expect(result.skipped).toEqual([{ path: "bad.stub", reason: "parse-failed", detail }])
    expect(warnings).toEqual([`Skipped bad.stub: ${detail}`])
  })

  it("subtracts it from parsedFiles once, and records no extraction failure", async () => {
    const { result } = await run({ errors: [refused("unterminated string")] })
    expect(result.ir.stats.totalFiles).toBe(3)
    expect(result.ir.stats.parsedFiles).toBe(2)
    expect(result.extractionFailures).toEqual([])
  })

  it("still reports its parse errors, which are diagnostic rather than IR", async () => {
    const errors = [refused("unterminated string")]
    const { result } = await run({ errors })
    expect(result.parseErrors).toEqual([{ file: "bad.stub", errors }])
  })

  it("leaves the files either side of it in the IR", async () => {
    const { result } = await run({ errors: [refused("unterminated string")] })
    expect(result.ir.symbols.map((s) => s.source.file)).toEqual(["a.stub", "c.stub"])
  })

  it("counts one file lost per reason when several reasons meet in one run", async () => {
    await workspace.writeSource("big.stub", "x".repeat(2000))
    await workspace.writeSource("boom.stub", "boom")
    await rm(join(workspace.root, "c.stub"))
    const language = parsingBadAs({ errors: [refused("refused")] })
    const throwing: LanguagePlugin = {
      ...language,
      parseFile: async (file) => {
        if (file.path === "boom.stub") throw new Error("stub parseFile exploded")
        return language.parseFile(file)
      },
    }

    const { ir, skipped } = await scanStubs(workspace.root, {
      config: { maxFileSizeBytes: 1024 },
      languages: [throwing],
    })

    expect(ir.stats.totalFiles).toBe(4)
    expect(ir.stats.parsedFiles).toBe(1)
    expect(skipped.map((s) => [s.path, s.reason])).toEqual([
      ["bad.stub", "parse-failed"],
      ["big.stub", "over-size"],
      ["boom.stub", "extraction-failed"],
    ])
    expect(ir.symbols.map((s) => s.source.file)).toEqual(["a.stub"])
  })

  it("skips nothing and warns about nothing for a file with only recoverable errors", async () => {
    const { result, warnings } = await run({ errors: [STRAY] })
    expect(result.skipped).toEqual([])
    expect(warnings).toEqual([])
    expect(result.ir.stats.parsedFiles).toBe(3)
  })
})
