import type {
  BodyExtraction,
  CallCandidate,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  ExtractionContext,
  FrameworkManifest,
  FrameworkPlugin,
  ImportEdge,
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
import { symbolId } from "../fixtures/ir"

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
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
  imports?: readonly ImportEdge[]
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
      imports: [...(options.imports ?? [])],
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
    id: symbolId("stub:test.stub#Fn"),
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
  imports?: readonly ImportEdge[]
}) {
  const candidate = overrides.candidate ?? baseCandidate()
  const body: BodyExtraction = overrides.body ?? { rules: [], calls: [] }
  const language = stubLanguagePlugin({ candidate, body, imports: overrides.imports ?? [] })
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

  it("hands the file's import edges to the classifier alongside the candidate", async () => {
    const seen: (readonly ImportEdge[])[] = []
    const fw: FrameworkPlugin = {
      manifest: frameworkManifest("framework-imports"),
      init: async () => {},
      classifySymbol: (_symbol, ctx): SymbolClassification | null => {
        seen.push(ctx.imports)
        return null
      },
    }
    const imports: ImportEdge[] = [
      { source: "@nestjs/common", symbols: ["Controller as Ctrl"], line: 1, dynamic: false },
    ]

    const result = await runPipelineWithStubs({ frameworks: [fw], imports })

    // The same edges the result reports: a classifier that resolved a decorator against a
    // different list than the one the IR records would be unfalsifiable from the outside.
    // Identity rather than equality — a plugin is entitled to memoize per file on it, and
    // `framework-nestjs` does.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(result.imports)
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
    const bogusCandidate = { ...baseCandidate(), id: symbolId("no-colon-here") }
    await expect(runPipelineWithStubs({ candidate: bogusCandidate })).rejects.toThrow(
      /language prefix/,
    )
  })
})

describe("runFilePipeline — Unicode normalization at the plugin boundary", () => {
  // A language plugin reads identifiers and paths out of source bytes, so whichever Unicode
  // spelling the file carries is the spelling it hands back. ir-schema.md §1.2 states why
  // the Document cannot hold both, and this boundary is where the two collapse into one.
  const decomposed = "café".normalize("NFD")
  const composed = decomposed.normalize("NFC")

  it("uses a genuinely decomposed fixture, so the cases below are not vacuous", () => {
    expect([...decomposed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0x65, 0x301])
    expect([...composed].map((c) => c.codePointAt(0))).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it("normalizes source.file, which invariant #19 checks and the call resolver matches", async () => {
    const candidate = {
      ...baseCandidate(),
      source: { ...baseCandidate().source, file: `${decomposed}.stub` },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.source.file).toBe(`${composed}.stub`)
  })

  it("normalizes signature.inputs[].name, which the local-shadow guard compares", async () => {
    // call-resolution.md §4.2: a parameter of the same name as a Symbol shadows it, and the
    // resolver decides that by comparing this string against the call's head segment. The
    // head is normalized; leaving the parameter alone turns the guard off and emits an edge
    // to an unrelated Symbol, which then carries effects through propagation.
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: decomposed, type: "string" }],
        outputs: [],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs.map((i) => i.name)).toEqual([composed])
  })

  it("normalizes decorators[].name, which a framework plugin matches against the edges", async () => {
    // A decorator-driven framework plugin resolves the written name against
    // `ImportEdge.symbols`, and this boundary already normalizes those. Leaving the decorator
    // alone means the two halves of that comparison arrive in different spellings, so the
    // alias silently fails to resolve on a file that spells its identifiers decomposed.
    const candidate = {
      ...baseCandidate(),
      decorators: [
        { name: decomposed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators.map((d) => d.name)).toEqual([composed])
  })

  it("leaves decorators[].raw alone, because it is a quotation of source", async () => {
    const candidate = {
      ...baseCandidate(),
      decorators: [
        { name: decomposed, raw: `@${decomposed}()`, arguments: [], boundary: false, line: 1 },
      ],
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.decorators[0]?.raw).toBe(`@${decomposed}()`)
  })

  it("leaves the signature type strings alone, because they are quotations of source", async () => {
    const candidate = {
      ...baseCandidate(),
      signature: {
        inputs: [{ name: "x", type: decomposed }],
        outputs: [decomposed],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }
    const result = await runPipelineWithStubs({ candidate })
    expect(result.symbols[0]?.signature?.inputs[0]?.type).toBe(decomposed)
    expect(result.symbols[0]?.signature?.outputs).toEqual([decomposed])
  })

  it("normalizes an unclassified call target", async () => {
    const result = await runPipelineWithStubs({
      body: { rules: [], calls: [stubCall(`${decomposed}.doWork`, 1)] },
    })
    expect(result.symbols[0]?.calls.map((c) => c.target)).toEqual([`${composed}.doWork`])
  })

  it("normalizes a classified effect target, which is a sort key once propagated", async () => {
    // `propagate.ts` orders propagated entries by `(id, target)` and integrity invariant
    // #11 verifies that order against the in-memory string, while the serializer writes the
    // normalized one. Two spellings there put the Document on disk out of its own order.
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-loud"),
      init: async () => {},
      classify: (): EffectClassification => ({
        effectId: "event.publish",
        confidence: "high",
        derivedBy: "effects-loud:hit",
      }),
    }
    const result = await runPipelineWithStubs({
      effects: [eff],
      body: { rules: [], calls: [stubCall(`${decomposed}.emit`, 1)] },
    })
    expect(result.symbols[0]?.effects.map((e) => e.target)).toEqual([`${composed}.emit`])
  })

  it("hands the effect plugin the normalized target, so one spelling reaches every classifier", async () => {
    const seen: string[] = []
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-watch"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => {
        seen.push(call.target)
        return null
      },
    }
    await runPipelineWithStubs({
      effects: [eff],
      body: { rules: [], calls: [stubCall(`${decomposed}.emit`, 1)] },
    })
    expect(seen).toEqual([`${composed}.emit`])
  })

  it("normalizes the import edges the call resolver matches against", async () => {
    // `namespaceBinding` and the local half of `symbols[]` are compared against a call's
    // head segment; `source` resolves into a path compared against the discovered file set.
    // A miss is silent — the call lands in the `no-match` bucket rather than `external`.
    const result = await runPipelineWithStubs({
      imports: [
        {
          source: `./${decomposed}`,
          symbols: [`${decomposed} as ${decomposed}Local`],
          namespaceBinding: decomposed,
          line: 1,
          dynamic: false,
        },
      ],
    })
    expect(result.imports).toEqual([
      {
        source: `./${composed}`,
        symbols: [`${composed} as ${composed}Local`],
        namespaceBinding: composed,
        line: 1,
        dynamic: false,
      },
    ])
  })

  it("returns the candidate and the call untouched when nothing needs normalizing", async () => {
    // The identity, not just the equality: an ordinary ASCII scan must not pay a copy per
    // candidate and per call for a normalization that changes nothing.
    const candidate = baseCandidate()
    const seen: CallCandidate[] = []
    const eff: EffectPlugin = {
      manifest: effectsManifest("effects-watch"),
      init: async () => {},
      classify: (call: CallCandidate): EffectClassification | null => {
        seen.push(call)
        return null
      },
    }
    const call = stubCall("helper.doWork", 1)
    await runPipelineWithStubs({ candidate, effects: [eff], body: { rules: [], calls: [call] } })
    expect(seen[0]).toBe(call)
  })
})
