import { describe, expectTypeOf, it } from "vitest"
import type {
  CallCandidate,
  ClassifyContext,
  Config,
  DiffResult,
  EffectClassification,
  EffectPlugin,
  ExtractionContext,
  FrameworkPlugin,
  ImportEdge,
  IR,
  LanguageCapabilities,
  LanguagePlugin,
  ParseResult,
  PluginContext,
  PluginManifest,
  SourceFile,
  Symbol,
  SymbolCandidate,
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
})
