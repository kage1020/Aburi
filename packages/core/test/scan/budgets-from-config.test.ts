import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectPlugin,
  EffectsManifest,
  ExtractionContext,
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
import { buildDropCFilter, DEFAULT_CLASSIFY_TIMEOUT_MS, runFilePipeline } from "../../src"
import { symbolId } from "../fixtures/ir"

/**
 * Both of the pipeline's budgets are read from the `Config` it is handed, and from nowhere
 * else. They used to be duplicated as optional fields on `FilePipelineInput`, which existed
 * only so a test could pass a number without building a config — so the two paths a budget
 * could arrive by were the production one and the tested one, and they were not the same one.
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

/** Spend `ms` of wall clock. A budget test can only fail in the direction of more time. */
function spend(ms: number): void {
  const until = performance.now() + ms
  let spins = 0
  while (performance.now() < until) spins++
  if (spins < 0) throw new Error("unreachable")
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

function effectsManifest(): EffectsManifest {
  return {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "effects-stub",
    version: "0.0.0",
    type: "effects",
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

function candidate(): SymbolCandidate<OpaqueAstNode> {
  return {
    id: symbolId("stub:test.stub#one"),
    kind: "function",
    extKind: null,
    name: "one",
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file: "test.stub", startLine: 1, endLine: 2, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

/** One Symbol with one call, so exactly one classify happens under exactly one budget. */
function stubLanguage(parseMs: number): LanguagePlugin {
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
    parseFile: async (_file: SourceFile): Promise<ParseResult> => {
      spend(parseMs)
      return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
    },
    extractSymbols: (_tree: OpaqueAstNode, _ctx: ExtractionContext) => [candidate()],
    walkBody: (
      _symbol: SymbolCandidate<OpaqueAstNode>,
      _ctx: WalkContext<OpaqueAstNode>,
    ): BodyExtraction => ({
      rules: [],
      calls: [
        {
          target: "db.query",
          line: 2,
          argumentCount: 0,
          inAwait: false,
          inNew: false,
          literalArgs: [],
        },
      ],
    }),
    normalizeAst: () => "stub-ast",
  }
  return plugin as unknown as LanguagePlugin
}

/** A classifier that spends `ms` before deciding nothing, so only the budget decides. */
function slowEffects(ms: number): EffectPlugin {
  return {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, _ctx: ClassifyContext) => {
      spend(ms)
      return null
    },
  }
}

function run(config: { parseTimeoutMs?: number; classifyTimeoutMs?: number }, effectMs: number) {
  return runFilePipeline({
    file: stubFile,
    language: stubLanguage(0),
    frameworks: [],
    effects: [slowEffects(effectMs)],
    registry: noopRegistry,
    config,
    dropCFilter: buildDropCFilter(),
    treeReleaseFailures: [],
    log: silentLog,
  })
}

describe("the classify budget comes from the config", () => {
  it("lets a classifier past the default run to completion when the config raised the budget", async () => {
    // The direction that cannot be faked: this classifier spends longer than the default, so
    // a pipeline reading anything but the config would record a timeout here.
    const slower = DEFAULT_CLASSIFY_TIMEOUT_MS + 30
    const result = await run({ classifyTimeoutMs: 5000 }, slower)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toEqual([])
  })

  it("reports the configured budget as the one that was blown", async () => {
    const result = await run({ classifyTimeoutMs: 10 }, 60)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toHaveLength(1)
    expect(result.timeoutEvents[0]?.budgetMs).toBe(10)
  })

  it("falls back to the documented default when the config names no budget", async () => {
    const result = await run({}, DEFAULT_CLASSIFY_TIMEOUT_MS + 30)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toHaveLength(1)
    expect(result.timeoutEvents[0]?.budgetMs).toBe(DEFAULT_CLASSIFY_TIMEOUT_MS)
  })
})

describe("the parse budget comes from the config", () => {
  it("abandons a file that overruns the budget the config named", async () => {
    const result = await runFilePipeline({
      file: stubFile,
      language: stubLanguage(250),
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      config: { parseTimeoutMs: 100 },
      dropCFilter: buildDropCFilter(),
      treeReleaseFailures: [],
      log: silentLog,
    })

    expect(result.kind).toBe("parse-timeout")
    if (result.kind !== "parse-timeout") return
    expect(result.timeout.budgetMs).toBe(100)
  })
})
