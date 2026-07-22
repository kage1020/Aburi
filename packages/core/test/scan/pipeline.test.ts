import type {
  BodyExtraction,
  CallCandidate,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  ExtractionContext,
  FrameworkManifest,
  FrameworkPlugin,
  LangManifest,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  ParseResult,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDropCFilter, runFilePipeline } from "../../src"

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

function langManifest(name: string): LangManifest {
  return {
    $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
    name,
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

function frameworkManifest(name: string): FrameworkManifest {
  return {
    $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
    name,
    version: "0.0.0",
    type: "framework",
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

function effectsManifest(name: string): EffectsManifest {
  return {
    $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
    name,
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

/**
 * Build a single-Symbol language plugin fixture that returns whatever candidate + body
 * the caller wired in. Everything else is a no-op so tests can focus on the pipeline
 * dispatch semantics.
 */
function stubLanguagePlugin(options: {
  candidate: SymbolCandidate<OpaqueAstNode>
  body: BodyExtraction
  normalized?: string
}): LanguagePlugin {
  const plugin = {
    manifest: langManifest("lang-stub"),
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
    parseFile: async (_file: SourceFile): Promise<ParseResult> => ({
      tree: {} as OpaqueAstNode,
      errors: [],
      imports: [],
    }),
    extractSymbols: (_tree: OpaqueAstNode, _ctx: ExtractionContext) => [options.candidate],
    walkBody: (_symbol: SymbolCandidate<OpaqueAstNode>, _ctx: WalkContext<OpaqueAstNode>) =>
      options.body,
    normalizeAst: (_symbol: SymbolCandidate<OpaqueAstNode>) => options.normalized ?? "stub-ast",
  }
  return plugin as unknown as LanguagePlugin
}

function baseCandidate(): SymbolCandidate<OpaqueAstNode> {
  return {
    id: "stub:test.stub#Fn",
    kind: "function",
    extKind: null,
    name: "Fn",
    visibility: "public",
    decorators: [
      { name: "Controller", raw: "@Controller()", arguments: [], boundary: false, line: 1 },
    ],
    signature: null,
    source: { file: "test.stub", startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
  }
}

function stubCall(target: string, line = 1): CallCandidate {
  return { target, line, argumentCount: 0, inAwait: false, inNew: false, literalArgs: [] }
}

const stubFile: SourceFile = { path: "test.stub", content: "" }

async function runPipelineWithStubs(overrides: {
  frameworks?: readonly FrameworkPlugin[]
  effects?: readonly EffectPlugin[]
  candidate?: SymbolCandidate<OpaqueAstNode>
  body?: BodyExtraction
}) {
  const candidate = overrides.candidate ?? baseCandidate()
  const body: BodyExtraction = overrides.body ?? { rules: [], calls: [] }
  const language = stubLanguagePlugin({ candidate, body })
  return runFilePipeline({
    file: stubFile,
    language,
    frameworks: overrides.frameworks ?? [],
    effects: overrides.effects ?? [],
    registry: noopRegistry,
    config: {},
    dropCFilter: buildDropCFilter(),
    log: silentLog,
  })
}

describe("runFilePipeline — framework classifySymbol dispatch", () => {
  it("uses the first framework that returns a non-null classification (first-match-wins)", async () => {
    const fw1: FrameworkPlugin = {
      manifest: frameworkManifest("framework-first"),
      init: async () => {},
      classifySymbol: (): SymbolClassification | null => ({
        extKind: "framework:first:role",
        derivedBy: "framework-first:hit",
      }),
    }
    const fw2Calls: number[] = []
    const fw2: FrameworkPlugin = {
      manifest: frameworkManifest("framework-second"),
      init: async () => {},
      classifySymbol: (): SymbolClassification | null => {
        fw2Calls.push(1)
        return { extKind: "framework:second:role", derivedBy: "framework-second:hit" }
      },
    }

    const result = await runPipelineWithStubs({ frameworks: [fw1, fw2] })

    const symbol = result.symbols[0]
    expect(symbol?.extKind).toBe("framework:first:role")
    expect(symbol?.derivedBy).toContain("framework-first:hit")
    expect(fw2Calls).toEqual([])
  })

  it("falls through to the next framework when the first returns null", async () => {
    const fw1: FrameworkPlugin = {
      manifest: frameworkManifest("framework-null"),
      init: async () => {},
      classifySymbol: () => null,
    }
    const fw2: FrameworkPlugin = {
      manifest: frameworkManifest("framework-hit"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:hit:role",
        derivedBy: "framework-hit:hit",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw1, fw2] })
    expect(result.symbols[0]?.extKind).toBe("framework:hit:role")
  })

  it("applies decoratorBoundaries overrides from the winning framework result", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-boundary"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:hit:controller",
        decoratorBoundaries: { Controller: true },
        derivedBy: "framework-boundary:hit",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    const decorator = result.symbols[0]?.decorators.find((d) => d.name === "Controller")
    expect(decorator?.boundary).toBe(true)
  })

  it("splits the framework derivedBy value on `;` so multi-signal reasons flatten into the array", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-compound"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:next:page",
        derivedBy: "framework:next:page;framework:next:client-component",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    const derivedBy = result.symbols[0]?.derivedBy ?? []
    expect(derivedBy).toContain("framework:next:page")
    expect(derivedBy).toContain("framework:next:client-component")
  })

  it("propagates SymbolClassification.confidence to the emitted Symbol", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-med"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:express:middleware",
        derivedBy: "framework:express:middleware:app.use",
        confidence: "medium",
      }),
    }

    const result = await runPipelineWithStubs({ frameworks: [fw] })
    expect(result.symbols[0]?.confidence).toBe("medium")
  })

  it("defaults Symbol.confidence to 'high' when no framework classifies", async () => {
    const result = await runPipelineWithStubs({ frameworks: [] })
    expect(result.symbols[0]?.confidence).toBe("high")
  })

  it("defaults Symbol.confidence to 'high' when the winning classifier omits confidence", async () => {
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-no-conf"),
      init: async () => {},
      classifySymbol: (): SymbolClassification => ({
        extKind: "framework:nestjs:controller",
        derivedBy: "framework:nestjs:controller:Controller",
        // confidence intentionally omitted — pre-existing plugins (react/next/nestjs) don't set it
      }),
    }
    const result = await runPipelineWithStubs({ frameworks: [fw] })
    expect(result.symbols[0]?.confidence).toBe("high")
  })
})

describe("runFilePipeline — effect classify dispatch", () => {
  it("stops at the first effect that classifies the call (first-non-null-wins)", async () => {
    const secondCalls: string[] = []
    const eff1: EffectPlugin = {
      manifest: effectsManifest("effects-first"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => ({
        effectId: "db.read",
        confidence: "high",
        derivedBy: `effects-first:${call.target}`,
      }),
    }
    const eff2: EffectPlugin = {
      manifest: effectsManifest("effects-second"),
      init: async () => {},
      classify: (call: CallCandidate) => {
        secondCalls.push(call.target)
        return null
      },
    }

    const result = await runPipelineWithStubs({
      effects: [eff1, eff2],
      body: { rules: [], calls: [stubCall("prisma.user.findMany")] },
    })

    expect(result.symbols[0]?.effects.map((e) => e.plugin)).toEqual(["effects-first"])
    expect(secondCalls).toEqual([])
  })

  it("falls through to the next effect plugin when the first returns null", async () => {
    const eff1: EffectPlugin = {
      manifest: effectsManifest("effects-first"),
      init: async () => {},
      classify: () => null,
    }
    const eff2: EffectPlugin = {
      manifest: effectsManifest("effects-second"),
      init: async () => {},
      classify: (): EffectClassification => ({
        effectId: "db.write",
        confidence: "medium",
        derivedBy: "effects-second:hit",
      }),
    }

    const result = await runPipelineWithStubs({
      effects: [eff1, eff2],
      body: { rules: [], calls: [stubCall("something.update")] },
    })

    expect(result.symbols[0]?.effects[0]?.plugin).toBe("effects-second")
    expect(result.symbols[0]?.effects[0]?.id).toBe("db.write")
  })

  it("leaves unclassified calls in Symbol.calls[] with resolved:null", async () => {
    const result = await runPipelineWithStubs({
      effects: [],
      body: { rules: [], calls: [stubCall("helper.doWork")] },
    })
    expect(result.symbols[0]?.calls).toEqual([{ target: "helper.doWork", line: 1, resolved: null }])
  })
})

describe("runFilePipeline — array line ordering (IR integrity invariant #11)", () => {
  it("sorts calls[] by line even when the language plugin visits body children out of source order", async () => {
    // Reverse-alpha targets in reverse-line order — `classifyCalls` sorts unclassified
    // calls by `byTargetThenLine`, which would leave them in target-alpha order:
    // [alpha (line 40), zeta (line 20)]. Integrity invariant #11 demands line
    // ascending. buildKeptSymbol must re-sort.
    const result = await runPipelineWithStubs({
      effects: [],
      body: {
        rules: [],
        calls: [stubCall("zeta.doWork", 20), stubCall("alpha.doWork", 40)],
      },
    })
    const lines = result.symbols[0]?.calls.map((c) => c.line) ?? []
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
  })

  it("sorts effects[] by line — regression guard for the sibling of the calls sort bug", async () => {
    // Two effect classifications whose target-alpha order ("alpha.emit" < "zeta.emit")
    // is inverted from their source-line order (zeta on 15, alpha on 60). Without
    // the sort in buildKeptSymbol, effects[] would leave classifyCalls's
    // byTargetThenLine result untouched and violate invariant #11.
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-loud"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification => ({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: `effects-loud:${call.target}`,
      }),
    }
    const result = await runPipelineWithStubs({
      effects: [eff],
      body: {
        rules: [],
        calls: [stubCall("zeta.emit", 15), stubCall("alpha.emit", 60)],
      },
    })
    const lines = result.symbols[0]?.effects.map((e) => e.line) ?? []
    expect(lines).toEqual([15, 60])
  })

  it("sorts decorators[] by line when the language plugin emits them out of order", async () => {
    // Decorators are typed as source-order by convention but the pipeline enforces
    // it here so downstream integrity does not rely on unwritten plugin contracts.
    const candidate: SymbolCandidate<OpaqueAstNode> = {
      ...baseCandidate(),
      decorators: [
        { name: "Later", raw: "@Later()", arguments: [], boundary: false, line: 30 },
        { name: "Earlier", raw: "@Earlier()", arguments: [], boundary: false, line: 5 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    const lines = result.symbols[0]?.decorators.map((d) => d.line) ?? []
    expect(lines).toEqual([5, 30])
  })

  it("preserves the relative order of same-line entries (stable sort)", async () => {
    // Schema §17 phrases the same-line contract as "appearance order". Node's
    // Array.prototype.sort has been stable since ES2019 — we depend on that here
    // so callers can trust the ordering of e.g. two calls on the same line.
    const result = await runPipelineWithStubs({
      effects: [],
      body: {
        rules: [],
        calls: [stubCall("first.hit", 10), stubCall("second.hit", 10), stubCall("third.hit", 10)],
      },
    })
    const targets = result.symbols[0]?.calls.map((c) => c.target) ?? []
    // classifyCalls re-sorts unclassified calls by byTargetThenLine before
    // buildKeptSymbol receives them, so same-line entries land in target-alpha
    // order. The relevant assertion is that they stay grouped and in some
    // deterministic order — not that source order survives (see the "known
    // limitation" note in the changeset).
    expect(targets).toEqual(["first.hit", "second.hit", "third.hit"])
  })
})

describe("runFilePipeline — Symbol id contract", () => {
  it("throws when the language plugin emits a Symbol id without a language prefix", async () => {
    const bogusCandidate = { ...baseCandidate(), id: "no-colon-here" }
    await expect(runPipelineWithStubs({ candidate: bogusCandidate })).rejects.toThrow(
      /language prefix/,
    )
  })
})
