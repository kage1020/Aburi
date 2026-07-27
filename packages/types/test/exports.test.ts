import { describe, expectTypeOf, it } from "vitest"
import type {
  CallCandidate,
  CallResolutionStats,
  ClassifyContext,
  Config,
  ConfigPluginRef,
  DiffGenerator,
  DiffResult,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  EffectVocab,
  ExtractionContext,
  FrameworkManifest,
  FrameworkPlugin,
  Generator,
  ImportEdge,
  IR,
  IRSymbol,
  LangManifest,
  LanguageCapabilities,
  LanguagePlugin,
  ManifestEffectVocab,
  ParseResult,
  PluginContext,
  PluginManifest,
  PluginRef,
  SliceRecord,
  SourceFile,
  Symbol,
  SymbolCandidate,
  UnresolvedCallBuckets,
  VocabRegistry,
} from "../src/index"

// Pure type-level tests. They compile-time-assert that the public surface stays
// importable and shaped roughly as designed. No runtime cost beyond Vitest's
// per-test bookkeeping.

describe("@aburi/types public surface", () => {
  it("re-exports the five AC-required root types", () => {
    expectTypeOf<IR>().not.toBeNever()
    expectTypeOf<Symbol>().not.toBeNever()
    expectTypeOf<DiffResult>().not.toBeNever()
    expectTypeOf<Config>().not.toBeNever()
    expectTypeOf<PluginManifest>().not.toBeNever()
  })

  it("exposes the three plugin contract roots", () => {
    expectTypeOf<LanguagePlugin>().not.toBeNever()
    expectTypeOf<EffectPlugin>().not.toBeNever()
    expectTypeOf<FrameworkPlugin>().not.toBeNever()
  })

  it("exposes the plugin context graph", () => {
    expectTypeOf<PluginContext>().toHaveProperty("registry")
    expectTypeOf<PluginContext>().toHaveProperty("config")
    expectTypeOf<PluginContext>().toHaveProperty("workspaceRoot")
    expectTypeOf<PluginContext>().toHaveProperty("log")
    expectTypeOf<ExtractionContext>().toHaveProperty("file")
    expectTypeOf<ExtractionContext>().toHaveProperty("registry")
    expectTypeOf<ClassifyContext>().toHaveProperty("owner")
    expectTypeOf<ClassifyContext>().toHaveProperty("file")
    expectTypeOf<ClassifyContext>().toHaveProperty("language")
  })

  it("models lang plugin extraction inputs/outputs", () => {
    expectTypeOf<SourceFile>().toEqualTypeOf<{ path: string; content: string }>()
    expectTypeOf<ParseResult>().toHaveProperty("tree")
    expectTypeOf<ParseResult>().toHaveProperty("errors")
    expectTypeOf<ParseResult>().toHaveProperty("imports")
    expectTypeOf<ImportEdge>().toHaveProperty("source")
    expectTypeOf<ImportEdge>().toHaveProperty("symbols")
    expectTypeOf<ImportEdge>().toHaveProperty("dynamic")
    expectTypeOf<SymbolCandidate>().toHaveProperty("id")
    expectTypeOf<SymbolCandidate>().toHaveProperty("decorators")
  })

  it("models effect classification", () => {
    expectTypeOf<CallCandidate>().toHaveProperty("target")
    expectTypeOf<CallCandidate>().toHaveProperty("argumentCount")
    expectTypeOf<CallCandidate>().toHaveProperty("literalArgs")
    expectTypeOf<EffectClassification>().toHaveProperty("effectId")
    expectTypeOf<EffectClassification>().toHaveProperty("confidence")
    expectTypeOf<EffectClassification>().toHaveProperty("derivedBy")
  })

  it("declares all 11 LanguageCapabilities flags", () => {
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasDecorators")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasGenerics")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasAsync")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasMacros")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasPatternMatching")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasAbstractTypes")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasModules")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasNamespaces")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasTypeParameters")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasExplicitVisibility")
    expectTypeOf<LanguageCapabilities>().toHaveProperty("hasJsDoc")
  })

  it("declares the VocabRegistry contract", () => {
    expectTypeOf<VocabRegistry["findEffect"]>().toBeFunction()
    expectTypeOf<VocabRegistry["findExtKind"]>().toBeFunction()
    expectTypeOf<VocabRegistry["findFramework"]>().toBeFunction()
    expectTypeOf<VocabRegistry["assertEffectDeclared"]>().toBeFunction()
    expectTypeOf<VocabRegistry["assertExtKindDeclared"]>().toBeFunction()
  })

  it("exposes SliceRecord as a top-level export and on DiffResult.slices", () => {
    expectTypeOf<SliceRecord>().toHaveProperty("id")
    expectTypeOf<SliceRecord>().toHaveProperty("members")
    expectTypeOf<SliceRecord["id"]>().toEqualTypeOf<string>()
    expectTypeOf<SliceRecord["members"]>().toEqualTypeOf<string[]>()
    expectTypeOf<DiffResult>().toHaveProperty("slices")
    expectTypeOf<DiffResult["slices"]>().toEqualTypeOf<SliceRecord[]>()
  })

  it("exposes CallResolutionStats as an optional Stats member with five buckets", () => {
    expectTypeOf<IR["stats"]>().toHaveProperty("callResolution")
    expectTypeOf<CallResolutionStats["totalCalls"]>().toEqualTypeOf<number>()
    expectTypeOf<CallResolutionStats["resolvedCalls"]>().toEqualTypeOf<number>()
    expectTypeOf<CallResolutionStats["unresolved"]>().toEqualTypeOf<UnresolvedCallBuckets>()
    expectTypeOf<UnresolvedCallBuckets>().toHaveProperty("localScope")
    expectTypeOf<UnresolvedCallBuckets>().toHaveProperty("external")
    expectTypeOf<UnresolvedCallBuckets>().toHaveProperty("dynamic")
    expectTypeOf<UnresolvedCallBuckets>().toHaveProperty("ambiguous")
    expectTypeOf<UnresolvedCallBuckets>().toHaveProperty("noMatch")
  })

  it("marks CallCandidate.dynamicReceiver optional so existing plugins stay valid", () => {
    expectTypeOf<CallCandidate>().toHaveProperty("dynamicReceiver")
    expectTypeOf<CallCandidate["dynamicReceiver"]>().toEqualTypeOf<boolean | undefined>()
  })

  it("disambiguating aliases stay distinct from their non-aliased siblings", () => {
    // IR.Generator carries plugin metadata; DiffGenerator is the lite name/version pair.
    expectTypeOf<Generator>().toHaveProperty("plugins")
    expectTypeOf<DiffGenerator>().not.toHaveProperty("plugins")

    // PluginRef in IR is the rich runtime snapshot; in config it is a string id (plugin spec).
    expectTypeOf<PluginRef>().toHaveProperty("name")
    expectTypeOf<ConfigPluginRef>().toEqualTypeOf<string>()

    // Manifest-declared EffectVocab is {id, description}; resolved EffectVocab adds an owner.
    expectTypeOf<ManifestEffectVocab>().not.toHaveProperty("owner")
    expectTypeOf<EffectVocab>().toHaveProperty("owner")

    // IRSymbol must be the same shape as Symbol (alias for callers that keep the global).
    expectTypeOf<IRSymbol>().toEqualTypeOf<Symbol>()
  })

  it("narrowed plugin manifests reject the wrong type discriminator", () => {
    const langOk: LangManifest = {
      $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
      name: "lang-foo",
      version: "1.0.0",
      type: "lang",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    }
    expectTypeOf(langOk.type).toEqualTypeOf<"lang">()

    const effectsOk: EffectsManifest = {
      $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
      name: "effects-foo",
      version: "1.0.0",
      type: "effects",
      xPrefix: "foo",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    }
    expectTypeOf(effectsOk.type).toEqualTypeOf<"effects">()

    const fwOk: FrameworkManifest = {
      $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
      name: "framework-foo",
      version: "1.0.0",
      type: "framework",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    }
    expectTypeOf(fwOk.type).toEqualTypeOf<"framework">()

    // @ts-expect-error -- type discriminator must match the narrow.
    const wrongType: LangManifest = { ...langOk, type: "effects" }
    expectTypeOf(wrongType).toEqualTypeOf<LangManifest>()
  })

  it("PluginManifest enforces required keys", () => {
    // @ts-expect-error -- missing required keys.
    const empty: PluginManifest = {}
    expectTypeOf(empty).toEqualTypeOf<PluginManifest>()

    // @ts-expect-error -- 'name' is required.
    const noName: PluginManifest = {
      $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
      version: "1.0.0",
      type: "lang",
      engines: { aburi: "^1.0.0" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: [],
        frameworks: [],
      },
    }
    expectTypeOf(noName).toEqualTypeOf<PluginManifest>()
  })

  it("ParseResult and SymbolCandidate are generic in the parser's tree/node types", () => {
    interface FakeTree {
      readonly __brand: "FakeTree"
    }
    interface FakeNode {
      readonly __brand: "FakeNode"
    }
    type SpecialPlugin = LanguagePlugin<FakeTree, FakeNode>
    type ParsedFake = Awaited<ReturnType<SpecialPlugin["parseFile"]>>
    expectTypeOf<ParsedFake["tree"]>().toEqualTypeOf<FakeTree | null>()
    type ExtractedFake = ReturnType<SpecialPlugin["extractSymbols"]>
    expectTypeOf<ExtractedFake[number]["fullNode"]>().toEqualTypeOf<FakeNode>()
  })
})
