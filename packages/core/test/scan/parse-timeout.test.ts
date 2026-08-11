import type {
  BodyExtraction,
  ExtractionContext,
  ImportEdge,
  LangManifest,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDropCFilter,
  DEFAULT_PARSE_TIMEOUT_MS,
  PARSE_TIMEOUT_MIN_MS,
  runFilePipeline,
  startParseDeadline,
} from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * `parseTimeoutMs` is a cooperative deadline: `extractSymbols` and `walkBody` are
 * synchronous plugin calls the runtime cannot preempt, so the budget is read where
 * control comes back to the pipeline. These tests make a stub plugin *deliberately spend*
 * the time rather than mocking a clock — the over-budget cases can only fail in the
 * direction of spending more, never less, so a slow machine cannot flake them. The
 * under-budget cases pass a budget large enough that no machine could blow it.
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

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const stubFile: SourceFile = { path: "test.stub", content: "" }

/** Spend `ms` of wall clock. The point is that the time is really gone. */
function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
}

function candidate(name: string): SymbolCandidate<OpaqueAstNode> {
  return {
    id: symbolId(`stub:test.stub#${name}`),
    kind: "function",
    extKind: null,
    name,
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file: "test.stub", startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
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

interface StubTiming {
  parseMs?: number
  extractMs?: number
  walkMsPerCandidate?: number
  candidates?: readonly string[]
  imports?: readonly ImportEdge[]
}

interface StubCalls {
  extract: number
  walk: string[]
}

function stubPlugin(timing: StubTiming, calls: StubCalls): LanguagePlugin {
  const names = timing.candidates ?? ["one"]
  const plugin = {
    manifest: langManifest(),
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
    parseFile: async (_file: SourceFile): Promise<ParseResult> => {
      spend(timing.parseMs ?? 0)
      return { tree: {} as OpaqueAstNode, errors: [], imports: [...(timing.imports ?? [])] }
    },
    extractSymbols: (_tree: OpaqueAstNode, _ctx: ExtractionContext) => {
      calls.extract++
      spend(timing.extractMs ?? 0)
      return names.map(candidate)
    },
    walkBody: (
      symbol: SymbolCandidate<OpaqueAstNode>,
      _ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => {
      calls.walk.push(symbol.name)
      spend(timing.walkMsPerCandidate ?? 0)
      return { rules: [], calls: [] }
    },
    normalizeAst: (_symbol: SymbolCandidate<OpaqueAstNode>) => "stub-ast",
  }
  return plugin as unknown as LanguagePlugin
}

async function run(timing: StubTiming, parseTimeoutMs?: number) {
  const calls: StubCalls = { extract: 0, walk: [] }
  const input: Parameters<typeof runFilePipeline>[0] = {
    file: stubFile,
    language: stubPlugin(timing, calls),
    frameworks: [],
    effects: [],
    registry: noopRegistry,
    config: {},
    dropCFilter: buildDropCFilter(),
    log: silentLog,
  }
  if (parseTimeoutMs !== undefined) input.parseTimeoutMs = parseTimeoutMs
  const result = await runFilePipeline(input)
  return { result, calls }
}

describe("parse deadline budget", () => {
  it("defaults to the 5000 ms the config schema documents", () => {
    expect(startParseDeadline(undefined).budgetMs).toBe(DEFAULT_PARSE_TIMEOUT_MS)
    expect(DEFAULT_PARSE_TIMEOUT_MS).toBe(5000)
  })

  it("clamps a value below the schema minimum up to it", () => {
    expect(startParseDeadline(1).budgetMs).toBe(PARSE_TIMEOUT_MIN_MS)
    expect(PARSE_TIMEOUT_MIN_MS).toBe(100)
  })

  it("takes a configured value above the minimum as written", () => {
    expect(startParseDeadline(250).budgetMs).toBe(250)
  })
})

describe("runFilePipeline — parse deadline", () => {
  it("abandons the file when parseFile alone blows the budget, without extracting", async () => {
    const { result, calls } = await run({ parseMs: 250 }, 100)
    expect(result.parseTimeout).not.toBeNull()
    expect(calls.extract).toBe(0)
    expect(calls.walk).toEqual([])
  })

  it("stops walking partway through the candidate list", async () => {
    const { result, calls } = await run(
      { candidates: ["one", "two", "three", "four"], walkMsPerCandidate: 60 },
      100,
    )
    expect(result.parseTimeout).not.toBeNull()
    expect(calls.extract).toBe(1)
    expect(calls.walk.length).toBeLessThan(4)
  })

  it("abandons a file whose extraction blew the budget and found nothing to walk", async () => {
    // With no candidates the per-candidate check never runs, so this is the only reading
    // that can catch a file that spent everything inside `extractSymbols`. Reported as a
    // timeout rather than as a file that legitimately holds no Symbols.
    const { result, calls } = await run({ candidates: [], extractMs: 250 }, 100)
    expect(result.parseTimeout).not.toBeNull()
    expect(calls.extract).toBe(1)
    expect(calls.walk).toEqual([])
  })

  it("reports the file, the budget in effect and the wall clock it actually spent", async () => {
    const { result } = await run({ parseMs: 250 }, 100)
    expect(result.parseTimeout?.file).toBe("test.stub")
    expect(result.parseTimeout?.budgetMs).toBe(100)
    expect(result.parseTimeout?.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it("hands back nothing at all from an abandoned file", async () => {
    const imports: readonly ImportEdge[] = [
      { source: "./other", symbols: ["thing"], line: 1, dynamic: false },
    ]
    const { result } = await run({ parseMs: 250, imports }, 100)
    expect(result.symbols).toEqual([])
    expect(result.imports).toEqual([])
    expect(result.parseErrors).toEqual([])
  })

  it("leaves a file that finishes inside its budget untouched", async () => {
    const { result, calls } = await run({ candidates: ["one", "two"] }, 600_000)
    expect(result.parseTimeout).toBeNull()
    expect(result.symbols.map((s) => s.name)).toEqual(["one", "two"])
    expect(calls.walk).toEqual(["one", "two"])
  })

  it("applies the default budget when the config omits one", async () => {
    const { result } = await run({ candidates: ["one"] })
    expect(result.parseTimeout).toBeNull()
    expect(result.symbols).toHaveLength(1)
  })
})
