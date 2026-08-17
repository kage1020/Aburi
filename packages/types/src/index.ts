// Public type surface for Aburi.
//
// Three sources are merged here:
//   1. Schema-generated types (src/generated/*.ts, regenerate via `pnpm --filter @aburi/types codegen`)
//   2. Hand-written plugin contracts (src/plugins.ts, derived from docs/design/*.md)
//   3. Per-run diagnostics (src/diagnostics.ts) — deliberately outside every schema
//
// A few names appear in multiple schemas with intentionally different shapes
// (e.g. IR's rich Generator vs Diff's lite Generator, manifest-declared EffectVocab vs
// registry-resolved EffectVocab). They are explicitly aliased to keep the surface unambiguous.

// ---------- Per-run diagnostics (not part of any schema) ----------
export type { UnresolvedCallBucket, UnresolvedCallDiagnostic } from "./diagnostics"
// ---------- Config (aburi.json / aburi.jsonc) ----------
export type {
  ComponentOverride,
  Config,
  FrameworkHint,
  HintRule,
  LspServerConfig,
  PluginRef as ConfigPluginRef,
} from "./generated/config"
// ---------- Diff output ----------
export type {
  ArrayDelta,
  ComponentDiff,
  DependencyDiff,
  DependencyUnknown,
  DiffResult,
  Generator as DiffGenerator,
  IRRef,
  MatchRationale,
  SignatureDelta,
  SliceId,
  SliceRecord,
  Summary,
  SymbolAdded,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolRemoved,
  SymbolUnknown,
} from "./generated/diff"
// ---------- IR (canonical runtime model) ----------
// Disambiguating alias so callers can keep the global `Symbol` in scope.
export type {
  Call,
  CallResolutionStats,
  Component,
  ComponentId,
  Confidence,
  Decorator,
  Dependency,
  DependencyEndpoint,
  Effect,
  EffectClassifyTimeout,
  EffectId,
  EffectPropagationStats,
  ExtKind,
  Fingerprint,
  Generator,
  IR,
  LanguageId,
  LspEnrichmentStats,
  PluginRef,
  RelativePath,
  Rule,
  RuleType,
  Signature,
  SkippedFile,
  SourceRange,
  Stats,
  Symbol,
  Symbol as IRSymbol,
  SymbolId,
  SymbolKind,
  UnresolvedCallBuckets,
  Visibility,
  Workspace,
  WorkspaceManager,
} from "./generated/ir"
// ---------- Plugin manifest (aburi.plugin.v1) ----------
export type {
  Capabilities,
  EffectVocab as ManifestEffectVocab,
  ExtKindVocab as ManifestExtKindVocab,
  PluginManifest,
  Provides,
} from "./generated/plugin"

// ---------- Hand-written plugin contracts ----------
export type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  DropHint,
  EffectClassification,
  EffectPlugin,
  EffectsManifest,
  EffectVocab,
  ExtKindVocab,
  ExtractionContext,
  FileSummary,
  FrameworkClassifyContext,
  FrameworkManifest,
  FrameworkPlugin,
  FrameworkVocab,
  ImportEdge,
  LangManifest,
  LanguageCapabilities,
  LanguagePlugin,
  Logger,
  OpaqueAstNode,
  OwnerSummary,
  ParsedTree,
  ParseError,
  ParseResult,
  PluginContext,
  SourceFile,
  SymbolCandidate,
  SymbolClassification,
  VocabRegistry,
  WalkContext,
  WrittenSourceRange,
} from "./plugins"
