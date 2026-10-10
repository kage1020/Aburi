import configSchema from "@aburi/schema/aburi.config.v1.json" with { type: "json" }
import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  ImportEdge,
  LanguagePlugin,
  OpaqueAstNode,
  ParseError,
  ParseResult,
  SymbolCandidate,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDropCFilter,
  DEFAULT_PARSE_TIMEOUT_MS,
  PARSE_TIMEOUT_MIN_MS,
  runFilePipeline,
  startParseDeadline,
  VocabCheck,
} from "../../src"
import { spend } from "../fixtures/clock"
import { stubCandidate, stubFile, stubLanguagePlugin } from "../fixtures/plugins"

interface StubTiming {
  parseMs?: number
  extractMs?: number
  walkMsPerCandidate?: number
  candidates?: readonly string[]
  imports?: readonly ImportEdge[]
  parseErrors?: readonly ParseError[]
  /** Return no tree at all, the way a plugin reports a file it could not parse. */
  noTree?: boolean
}

interface StubCalls {
  extract: number
  walk: string[]
}

function stubPlugin(timing: StubTiming, calls: StubCalls): LanguagePlugin {
  const names = timing.candidates ?? ["one"]
  return stubLanguagePlugin({
    parseFile: async (): Promise<ParseResult> => {
      spend(timing.parseMs ?? 0)
      return {
        tree: timing.noTree === true ? null : ({} as OpaqueAstNode),
        errors: [...(timing.parseErrors ?? [])],
        imports: [...(timing.imports ?? [])],
      }
    },
    extractSymbols: () => {
      calls.extract++
      spend(timing.extractMs ?? 0)
      return names.map((name) => stubCandidate(name))
    },
    walkBody: (symbol: SymbolCandidate<OpaqueAstNode>): BodyExtraction => {
      calls.walk.push(symbol.name)
      spend(timing.walkMsPerCandidate ?? 0)
      return { rules: [], calls: [] }
    },
  })
}

async function run(timing: StubTiming, parseTimeoutMs?: number) {
  const calls: StubCalls = { extract: 0, walk: [] }
  const input: Parameters<typeof runFilePipeline>[0] = {
    file: stubFile,
    language: stubPlugin(timing, calls),
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    vocab: new VocabCheck(noopRegistry, true),
    config: parseTimeoutMs === undefined ? {} : { parseTimeoutMs },
    dropCFilter: buildDropCFilter(),
    component: null,
    treeReleaseFailures: [],
    log: silentLogger,
  }
  const result = await runFilePipeline(input)
  return { result, calls }
}

describe("parse deadline budget", () => {
  const spec = configSchema.properties.parseTimeoutMs

  it("defaults to what the config schema documents", () => {
    expect(startParseDeadline(undefined).budgetMs).toBe(DEFAULT_PARSE_TIMEOUT_MS)
    expect(DEFAULT_PARSE_TIMEOUT_MS).toBe(spec.default)
  })

  it("clamps a value below the schema minimum up to it", () => {
    expect(startParseDeadline(1).budgetMs).toBe(PARSE_TIMEOUT_MIN_MS)
    expect(PARSE_TIMEOUT_MIN_MS).toBe(spec.minimum)
  })

  it("takes a configured value above the minimum as written", () => {
    expect(startParseDeadline(250).budgetMs).toBe(250)
  })
})

describe("runFilePipeline — parse deadline", () => {
  it("abandons the file when parseFile alone blows the budget, without extracting", async () => {
    const { result, calls } = await run({ parseMs: 250 }, 100)
    expect(result.kind).toBe("parse-timeout")
    expect(calls.extract).toBe(0)
    expect(calls.walk).toEqual([])
  })

  it("stops walking partway through the candidate list, and keeps nothing it walked", async () => {
    const { result, calls } = await run(
      { candidates: ["one", "two", "three", "four"], walkMsPerCandidate: 60 },
      100,
    )
    expect(result.kind).toBe("parse-timeout")
    expect(calls.extract).toBe(1)
    expect(calls.walk.length).toBeLessThanOrEqual(2)
    expect("symbols" in result).toBe(false)
    expect("imports" in result).toBe(false)
  })

  it("keeps the parse errors of a file it abandons", async () => {
    const parseErrors: readonly ParseError[] = [
      { message: "unexpected token", line: 1, column: 1, recoverable: true },
    ]
    const { result } = await run({ parseMs: 250, parseErrors }, 100)
    expect(result.kind).toBe("parse-timeout")
    expect(result.parseErrors).toEqual(parseErrors)
  })

  it("reports a file with no tree as a parse failure rather than as a timeout", async () => {
    const { result } = await run({ parseMs: 250, noTree: true }, 100)
    expect(result.kind).toBe("parse-failed")
  })

  it("reports a refused file as a parse failure even when the parse also blew the budget", async () => {
    const parseErrors: readonly ParseError[] = [
      { message: "wrong dialect", line: 1, column: 1, recoverable: false },
    ]
    const { result } = await run({ parseMs: 250, parseErrors }, 100)
    expect(result.kind).toBe("parse-failed")
  })

  it("abandons a file whose extraction blew the budget and found nothing to walk", async () => {
    const { result, calls } = await run({ candidates: [], extractMs: 250 }, 100)
    expect(result.kind).toBe("parse-timeout")
    expect(calls.extract).toBe(1)
    expect(calls.walk).toEqual([])
  })

  it("reports the file, the budget in effect and the wall clock it actually spent", async () => {
    const { result } = await run({ parseMs: 250 }, 100)
    expect(result.kind).toBe("parse-timeout")
    if (result.kind !== "parse-timeout") return
    expect(result.timeout.file).toBe("test.stub")
    expect(result.timeout.budgetMs).toBe(100)
    expect(result.timeout.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it("hands back nothing at all from an abandoned file", async () => {
    const imports: readonly ImportEdge[] = [
      { source: "./other", symbols: ["thing"], line: 1, dynamic: false },
    ]
    const { result } = await run({ parseMs: 250, imports }, 100)
    expect(Object.keys(result).sort()).toEqual(["kind", "parseErrors", "path", "timeout"])
  })

  it("leaves a file that finishes inside its budget untouched", async () => {
    const { result, calls } = await run({ candidates: ["one", "two"] }, 600_000)
    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.symbols.map((sym) => sym.name)).toEqual(["one", "two"])
    expect(calls.walk).toEqual(["one", "two"])
  })

  it("applies the default budget when the config omits one", async () => {
    const { result } = await run({ candidates: ["one"] })
    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.symbols).toHaveLength(1)
  })
})
