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
import { describe, expect, it } from "vitest"
import configSchema from "../../../../schema/aburi.config.v1.json" with { type: "json" }
import {
  buildDropCFilter,
  DEFAULT_PARSE_TIMEOUT_MS,
  PARSE_TIMEOUT_MIN_MS,
  runFilePipeline,
  startParseDeadline,
} from "../../src"
import { spend } from "../fixtures/clock"
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
      return {
        tree: timing.noTree === true ? null : ({} as OpaqueAstNode),
        errors: [...(timing.parseErrors ?? [])],
        imports: [...(timing.imports ?? [])],
      }
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
    // Through the config rather than beside it: the pipeline reads its budgets from the
    // same object production hands it, so a test cannot exercise a path the CLI cannot.
    config: parseTimeoutMs === undefined ? {} : { parseTimeoutMs },
    dropCFilter: buildDropCFilter(),
    treeReleaseFailures: [],
    log: silentLog,
  }
  const result = await runFilePipeline(input)
  return { result, calls }
}

describe("parse deadline budget", () => {
  // Against the schema rather than against a literal: the constants exist to mirror it, so
  // a test that repeated the numbers would be a third copy and would stay green while the
  // two that matter drifted apart.
  const spec = configSchema.properties.parseTimeoutMs

  it("defaults to what the config schema documents", () => {
    expect(startParseDeadline(undefined).budgetMs).toBe(DEFAULT_PARSE_TIMEOUT_MS)
    expect(DEFAULT_PARSE_TIMEOUT_MS).toBe(spec.default)
  })

  it("clamps a value below the schema minimum up to it", () => {
    // Only reachable programmatically — ajv refuses a config file that says less than this
    // long before `startParseDeadline` sees it.
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
    // 60 ms a candidate against 100: the check before the third is the first that can
    // find the budget spent, and a slower machine only finds it sooner.
    expect(calls.walk.length).toBeLessThanOrEqual(2)
    // The Symbols already built go with the rest. This is the contract that makes the
    // outcome binary rather than a function of how fast the machine was — and it is the
    // type that says so now: an abandoned file has no key to put them under.
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
    // One outcome per file, so the two cannot both be reported — the withdrawal is decided
    // before the first deadline reading, and a file that carried both would be labelled by
    // whichever the caller tested first.
    const { result } = await run({ parseMs: 250, noTree: true }, 100)
    expect(result.kind).toBe("parse-failed")
  })

  it("reports a refused file as a parse failure even when the parse also blew the budget", async () => {
    // The other half of the same exclusion. Reported as a timeout, a plugin's outright
    // refusal would send the reader to raise a budget that was never the problem.
    const parseErrors: readonly ParseError[] = [
      { message: "wrong dialect", line: 1, column: 1, recoverable: false },
    ]
    const { result } = await run({ parseMs: 250, parseErrors }, 100)
    expect(result.kind).toBe("parse-failed")
  })

  it("abandons a file whose extraction blew the budget and found nothing to walk", async () => {
    // With no candidates the per-candidate check never runs, so this is the only reading
    // that can catch a file that spent everything inside `extractSymbols`. Reported as a
    // timeout rather than as a file that legitimately holds no Symbols.
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
    // The whole key set rather than a list of absences: an outcome that grew a field nobody
    // meant it to have would pass an enumeration of the ones it must not have.
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
