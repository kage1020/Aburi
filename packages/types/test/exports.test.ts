import { describe, expectTypeOf, it } from "vitest"
import type {
  CallCandidate,
  CallResolutionStats,
  ClassifyContext,
  ComponentId,
  Config,
  ConfigPluginRef,
  Dependency,
  DependencyEndpoint,
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
  SliceId,
  SliceRecord,
  SourceFile,
  SourceRange,
  Symbol,
  SymbolCandidate,
  SymbolId,
  UnresolvedCallBuckets,
  VocabRegistry,
  WrittenSourceRange,
} from "../src/index"

// Pure type-level tests. They compile-time-assert that the public surface stays
// importable and shaped roughly as designed. No runtime cost beyond Vitest's
// per-test bookkeeping.
//
// `expectTypeOf` erases at runtime: `pnpm test` alone can never fail an assertion in this
// file. `pnpm typecheck` is what enforces them, and CI runs both — a green vitest run here
// means the file imported, not that the types hold.

/**
 * Is a value of type `From` accepted where `To` is expected? Wrapping both sides in a tuple
 * stops the conditional from distributing over unions, so `Assignable<SymbolId | ComponentId,
 * SymbolId>` answers about the union as a whole rather than member by member.
 */
type Assignable<From, To> = [From] extends [To] ? true : false

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
    expectTypeOf<SliceRecord["id"]>().toEqualTypeOf<SliceId>()
    expectTypeOf<SliceRecord["members"]>().toEqualTypeOf<SymbolId[]>()
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
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
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

  // The three id types own separate namespaces (ir-schema.md §3.5). JSON Schema cannot say
  // so — all three are `{"type": "string"}` on the wire — so the distinction is layered on by
  // the codegen brand pass, and these assertions are what proves it survived regeneration.
  //
  // `Assignable` is spelled out rather than reached through `expectTypeOf().toExtend()`
  // because the negative direction is the interesting one: a structural alias would make
  // every one of these pass.
  it("SymbolId / ComponentId / SliceId are mutually distinct nominal types", () => {
    expectTypeOf<Assignable<SymbolId, ComponentId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<ComponentId, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SymbolId, SliceId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SliceId, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<ComponentId, SliceId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SliceId, ComponentId>>().toEqualTypeOf<false>()
  })

  it("a bare string is not an id, but every id is a string", () => {
    expectTypeOf<Assignable<string, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<string, ComponentId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<string, SliceId>>().toEqualTypeOf<false>()
    // The other direction must keep working: ids are passed to `startsWith`, `localeCompare`,
    // template literals and every `(s: string) => ...` helper in the projection layer.
    expectTypeOf<Assignable<SymbolId, string>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<ComponentId, string>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<SliceId, string>>().toEqualTypeOf<true>()
  })

  it("a slice id cannot be produced by concatenation", () => {
    // What `sliceIdFor` in @aburi/diff exists to prevent: the template literal evaluates to
    // `string`, which the brand rejects, so the derivation has to go through the one helper.
    expectTypeOf<Assignable<`slice:${string}`, SliceId>>().toEqualTypeOf<false>()
  })

  it("Dependency endpoints admit either id kind but not a bare string", () => {
    expectTypeOf<Dependency["from"]>().toEqualTypeOf<DependencyEndpoint>()
    expectTypeOf<Dependency["to"]>().toEqualTypeOf<DependencyEndpoint>()
    expectTypeOf<Assignable<SymbolId, DependencyEndpoint>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<ComponentId, DependencyEndpoint>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<string, DependencyEndpoint>>().toEqualTypeOf<false>()
  })

  it("the plugin contract hands core an already-validated Symbol id", () => {
    expectTypeOf<SymbolCandidate["id"]>().toEqualTypeOf<SymbolId>()
    expectTypeOf<Assignable<string, SymbolCandidate["id"]>>().toEqualTypeOf<false>()
    expectTypeOf<Symbol["id"]>().toEqualTypeOf<SymbolId>()
    expectTypeOf<Symbol["component"]>().toEqualTypeOf<ComponentId | null | undefined>()
  })

  it("the write side of SourceRange is stricter than the read side (ir-schema.md §1.1)", () => {
    // Class A says a writer always emits both column keys, carrying `null` when the
    // position is unknown. `WrittenSourceRange` is that rule as a type, so a plugin that
    // omits a column fails to compile instead of quietly emitting a shape the convention
    // forbids -- `serializeCanonical` drops `undefined` properties, so the omission would
    // otherwise be invisible in TypeScript and visible only in the emitted bytes.
    expectTypeOf<SymbolCandidate["source"]>().toEqualTypeOf<WrittenSourceRange>()
    expectTypeOf<WrittenSourceRange["startColumn"]>().toEqualTypeOf<number | null>()
    expectTypeOf<WrittenSourceRange["endColumn"]>().toEqualTypeOf<number | null>()
    expectTypeOf<Assignable<SourceRange, WrittenSourceRange>>().toEqualTypeOf<false>()

    // The read side stays tolerant: an IR loaded off disk may predate the rule and omit the
    // keys, so narrowing `Symbol["source"]` would make a valid v1 document unrepresentable.
    expectTypeOf<Symbol["source"]>().toEqualTypeOf<SourceRange>()
    expectTypeOf<SourceRange["startColumn"]>().toEqualTypeOf<number | null | undefined>()
    // ...and a writer's range is still a range, so nothing downstream needs the narrow type.
    expectTypeOf<Assignable<WrittenSourceRange, SourceRange>>().toEqualTypeOf<true>()
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
