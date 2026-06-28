// Public type surface for Aburi.
//
// Three sources are merged here:
//   1. Schema-generated types (src/generated/*.ts, regenerate via `pnpm --filter @aburi/types codegen`)
//   2. Hand-written plugin contracts (src/plugins.ts, derived from design/details/*.md)
//
// A few names appear in multiple schemas with intentionally different shapes
// (e.g. IR's rich Generator vs Diff's lite Generator, manifest-declared EffectVocab vs
// registry-resolved EffectVocab). They are explicitly aliased to keep the surface unambiguous.

// ---------- Config (aburi.json / aburi.jsonc) ----------
export type {
  ComponentOverride,
  Config,
  FrameworkHint,
  HintRule,
  PluginRef as ConfigPluginRef,
} from "./generated/config"
// ---------- Diff output ----------
export type {
  ArrayDelta,
  ComponentDiff,
  DependencyDiff,
  DiffResult,
  Generator as DiffGenerator,
  IRRef,
  MatchRationale,
  SignatureDelta,
  Summary,
  SymbolAdded,
  SymbolChange,
  SymbolChanged,
  SymbolDelta,
  SymbolDroppedToggled,
  SymbolMoved,
  SymbolMovedChanged,
  SymbolRemoved,
} from "./generated/diff"
// ---------- IR (canonical runtime model) ----------
export type {
  Call,
  Component,
  ComponentId,
  Confidence,
  Decorator,
  Dependency,
  Effect,
  EffectClassifyTimeout,
  EffectId,
  ExtKind,
  Fingerprint,
  Generator,
  IR,
  LanguageId,
  PluginRef,
  RelativePath,
  Rule,
  RuleType,
  Signature,
  SourceRange,
  Stats,
  Symbol,
  SymbolId,
  SymbolKind,
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
  EffectVocab,
  ExtKindVocab,
  ExtractionContext,
  FileSummary,
  FrameworkPlugin,
  FrameworkVocab,
  ImportEdge,
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
} from "./plugins"
