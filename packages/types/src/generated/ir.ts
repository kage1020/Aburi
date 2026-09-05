// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.ir.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
export interface PluginRef {
name: string
type: ("lang" | "framework" | "effects")
version: string
/**
 * type=lang: required, format '<grammar-package>@<MAJOR.MINOR.PATCH>'. type=framework/effects: null.
 */
grammarRevision: (string | null)
}
/**
 * POSIX path relative to workspace root. Backslash is disallowed.
 */
export type RelativePath = string
/**
 * Language plugin id. Examples: ts, tsx, js, py, go, rs, java, kt, scala, rb, php, cs.
 */
export type LanguageId = string & { readonly __brand: "LanguageId" }
/**
 * ASCII kebab-case.
 */
export type ComponentId = string & { readonly __brand: "ComponentId" }
export interface Symbol {
id: SymbolId
kind: SymbolKind
extKind: ExtKind
name: string
language: LanguageId
/**
 * Component this Symbol belongs to. Class A per ir-schema.md §1.1: writers MUST emit the key on every Symbol, carrying null when the Symbol lies outside every declared Component. Readers MUST treat an absent key as null.
 */
component?: (ComponentId | null)
visibility: Visibility
decorators: Decorator[]
/**
 * Callable signature. Class A per ir-schema.md §1.1: writers MUST emit the key on every Symbol, carrying null for Symbols that have no callable signature (class bodies, whole interfaces). Readers MUST treat an absent key as null.
 */
signature?: (Signature | null)
rules: Rule[]
effects: Effect[]
calls: Call[]
source: SourceRange
fingerprint: Fingerprint
confidence: Confidence
derivedBy: string[]
dropped: boolean
dropReason: (string | null)
}
/**
 * Format: <language>:<posix-relative-path>#<qualified-name>. Backslash forbidden anywhere (POSIX path enforcement).
 */
export type SymbolId = string & { readonly __brand: "SymbolId" }
export type SymbolKind = ("function" | "method" | "class" | "interface" | "type" | "const" | "module" | "namespace" | "variable" | "enum" | "constructor" | "call")
export type ExtKind = (null | string)
export type Visibility = ("public" | "private" | "protected" | "internal" | "package")
export interface Rule {
type: RuleType
line: number
condition: (string | null)
what: (string | null)
expr: (string | null)
loopKind: (("for" | "while" | "do") | null)
}
export type RuleType = ("guard" | "throw" | "return" | "loop" | "try" | "switch" | "match")
export interface Effect {
id: EffectId
target: string
/**
 * Source line of the call that produced this effect. Class B per ir-schema.md §1.1: meaningless on a propagated entry, whose origin is N hops away, so writers MUST omit the key there rather than emit null or a placeholder (effect-propagation.md §5.1). The allOf below turns that rule into a validation error.
 */
line?: number
plugin: string
confidence: Confidence
/**
 * Evidence string from the effect plugin classifier (effect-plugin.md §4.4). Locally-detected entries carry the plugin's original value verbatim. On merge across propagation paths, the lexicographically-smallest string wins (effect-propagation.md §5.2).
 */
derivedBy: string
/**
 * True when the entry was produced by the effect-propagation pass (effect-propagation.md §5.1). Class B per ir-schema.md §1.1: absent on locally-detected entries. The allOf below reads presence, so a writer that emitted false where it means absent would still validate but would misreport intent.
 */
propagated?: boolean
/**
 * Direct upstream callee Symbol id(s) that carried this (effectId, target) into the current Symbol. Sorted ascending. Class B per ir-schema.md §1.1: present only when propagated=true, never emitted as [] on a locally-detected entry. The allOf below turns that into a validation error.
 */
derivedFrom?: SymbolId[]
}
export type EffectId = (("db.read" | "db.write" | "db.transaction" | "db.migration" | "network.http" | "network.ws" | "network.rpc" | "queue.publish" | "queue.consume" | "event.publish" | "event.subscribe" | "fs.read" | "fs.write" | "state.mutate" | "collection.mutate" | "time.now" | "time.timer" | "random" | "env.read" | "env.write" | "process.exit" | "process.signal") | string)
export type Confidence = ("high" | "medium" | "low")
/**
 * Either a Symbol id or a Component id; which one is recovered from the id shape (§11). Deliberately looser than SymbolId and ComponentId so that both fit and so a malformed endpoint is reported by the integrity checker rather than by the schema, which cannot say which of the two kinds was intended.
 */
export type DependencyEndpoint = SymbolId | ComponentId

/**
 * Aburi intermediate representation (aburi.ir.v1). Source of truth for L3; L0-L2 Markdown views are derived deterministically from this.
 */
export interface IR {
$schema: "https://aburi.kage1020.com/schema/aburi.ir.v1.json"
generator: Generator
/**
 * ISO 8601 UTC. Excluded from fingerprint. Class B per ir-schema.md §1.1: --no-timestamp omits the key entirely rather than emitting null, so a committed IR carries no producer clock at all.
 */
generatedAt?: string
workspace: Workspace
components: Component[]
symbols: Symbol[]
dependencies: Dependency[]
stats: Stats
}
export interface Generator {
name: string
version: string
/**
 * All plugins (lang/framework/effects) participating in this IR generation. Used for diff-time comparability checks (syntax fingerprint vs grammarRevision, effect classifications vs version).
 */
plugins: PluginRef[]
}
export interface Workspace {
/**
 * Always '.'. IRs must not contain absolute paths.
 */
root: "."
managers: WorkspaceManager[]
/**
 * @minItems 1
 */
languages: LanguageId[]
}
export interface WorkspaceManager {
/**
 * Runtime-agnostic package/workspace manager id. Common values: pnpm, npm, yarn, bun, uv, poetry, pip, cargo, go, mvn, gradle, hatch, pixi.
 */
tool: string
roots: RelativePath[]
}
export interface Component {
id: ComponentId
name: string
/**
 * @minItems 1
 */
roots: RelativePath[]
/**
 * Glob patterns or symbol ids that designate the component's public surface. POSIX (no backslash). Class B per ir-schema.md §1.1: writers MUST omit the key when the component declares no public surface, never emit as [].
 */
publicApi?: string[]
/**
 * @minItems 1
 */
languages: LanguageId[]
/**
 * Framework plugin names that claimed this component. Class B per ir-schema.md §1.1: writers MUST omit the key when no framework matched, never emit as [].
 */
frameworks?: string[]
/**
 * Human-facing blurb for the component, supplied through config. Class A per ir-schema.md §1.1: writers MUST emit the key on every Component, carrying null when no description was supplied. Readers MUST treat an absent key as null.
 */
description?: (string | null)
}
export interface Decorator {
name: string
raw: string
arguments: string[]
boundary: boolean
line: number
}
export interface Signature {
inputs: {
name: string
type: string
}[]
outputs: string[]
throws: string[]
/**
 * Throws inferred from callees' declared signatures by the LSP enrichment pass (lsp-enrichment.md §7.1). Distinct from `throws` so LSP enablement never perturbs the `api` fingerprint. Class B per ir-schema.md §1.1: writers MUST omit the key entirely when nothing was inferred, never emit as [].
 * 
 * @minItems 1
 */
inferredThrows?: string[]
async: boolean
generator: boolean
typeParameters: string[]
}
export interface Call {
target: string
line: number
resolved: (SymbolId | null)
}
export interface SourceRange {
file: RelativePath
startLine: number
endLine: number
/**
 * 1-based start column, populated by the LSP enrichment pass (lsp-enrichment.md §4.2). Class A per ir-schema.md §1.1: writers MUST emit the key on every SourceRange, carrying null while no column has been recorded — the in-tree TypeScript plugin deliberately leaves it null so that every column comes from one source, and any LSP fallback leaves it null too. Readers MUST treat an absent key as null; absence only occurs on documents that predate the rule. Out of `required` solely because the promotion is breaking under §15.2 (see §15.4).
 */
startColumn?: (number | null)
/**
 * 1-based end column. Same Class A contract as startColumn (ir-schema.md §1.1).
 */
endColumn?: (number | null)
}
export interface Fingerprint {
api: string
logic: string
syntax: string
}
export interface Dependency {
from: DependencyEndpoint
to: DependencyEndpoint
via: ("import" | "call" | "inherit" | "implement" | "compose" | "http" | "event" | "sql")
direction: ("outbound" | "inbound" | "bidirectional")
effect: (EffectId | null)
}
export interface Stats {
totalFiles: number
parsedFiles: number
keptSymbols: number
droppedSymbols: number
/**
 * Records effect classifications aborted after exceeding classifyTimeoutMs (effect-plugin.md §5.1.1). Class B per ir-schema.md §1.1: writers omit the key when nothing timed out rather than emitting []; non-empty entries are kept as a determinism log.
 */
effectClassifyTimeouts?: EffectClassifyTimeout[]
effectPropagation: EffectPropagationStats
lspEnrichment?: LspEnrichmentStats
callResolution?: CallResolutionStats
/**
 * Every file the scan gave up on, and why. Class B per ir-schema.md §1.1: writers omit the key when nothing was lost rather than emitting []. Without it the only trace of a loss is totalFiles > parsedFiles, which names no file — so a diff against a document that lost one reports its Symbols as deliberately deleted API. Sorted by path; invariant #21 holds the length to totalFiles - parsedFiles.
 */
skippedFiles?: SkippedFile[]
}
export interface EffectClassifyTimeout {
/**
 * Effect plugin manifest name that timed out.
 */
plugin: string
/**
 * Affected Symbol id (extraction-stage uniqueness guaranteed).
 */
symbolId: string
/**
 * The classifyTimeoutMs value in effect at the time of timeout.
 */
timeoutMs: number
}
/**
 * Counters produced by the effect-propagation pass (effect-propagation.md §10). Always present so a run with zero propagated effects still reports the SCC shape it observed.
 */
export interface EffectPropagationStats {
/**
 * Number of strongly connected components observed in the call graph. Singleton (non-cyclic) Symbols each count as one SCC.
 */
sccCount: number
/**
 * Largest SCC size. 0 when the graph is empty; 1 when acyclic.
 */
maxSccSize: number
/**
 * Total number of propagated Effect entries written across all Symbols.
 */
propagatedEffectCount: number
/**
 * Number of Symbols that received at least one propagated Effect.
 */
symbolsWithPropagatedEffects: number
}
/**
 * Bookkeeping from the LSP enrichment pass (lsp-enrichment.md §7.2). Class B per ir-schema.md §1.1: present when the pass ran regardless of whether it succeeded or fell back, absent when config.lsp is not configured. Presence is how a reader tells "ran and enriched nothing" apart from "never ran".
 */
export interface LspEnrichmentStats {
/**
 * Whether config.lsp.enabled was true and any server was configured for a discovered language.
 */
enabled: boolean
/**
 * Files that completed the enrichment pass without hitting per-file fallback.
 */
filesEnriched: number
/**
 * Files that triggered per-file fallback (lsp-enrichment.md §6.1).
 */
filesFellBack: number
/**
 * Total LSP requests issued across all files and languages.
 */
requestsIssued: number
/**
 * Requests that hit requestTimeoutMs (lsp-enrichment.md §6.1 per-request fallback).
 */
requestsTimedOut: number
/**
 * Requests that failed with a non-timeout error (server-error, server-disconnected, parse-error). Kept distinct from requestsTimedOut so operators can tell backpressure apart from broken servers.
 */
requestsFailed: number
/**
 * Languages that were disabled mid-run via per-language fallback. Sorted ascending.
 */
languagesDisabled: LanguageId[]
/**
 * Receiver hints the pass wrote from a hover it could read all the way to a callee Symbol (lsp-enrichment.md §7.2). Counts conversions, not surviving map entries: two call sites on one line share a hint key, so the second replaces the first. Class B per ir-schema.md §1.1: the current pipeline always emits it alongside the rest of this record, so absence means the document predates the counter rather than that no hint was produced.
 */
hintsProduced?: number
/**
 * Call sites the resolver turned into an edge from a receiver hint (call-resolution.md §5.2). Counts call sites rather than distinct hints, and only those the untyped tiers had already missed — a hint the untyped tier made unnecessary is neither consumed nor rejected. Class B per ir-schema.md §1.1: the current pipeline always emits it alongside the rest of this record, so absence means the document predates the counter rather than that no hint was consumed.
 */
hintsConsumed?: number
hintsRejected?: LspHintRejections
}
/**
 * Why the remaining hover results and receiver hints produced no edge (lsp-enrichment.md §7.2). Class B per ir-schema.md §1.1: the current pipeline always emits it alongside the rest of this record, so absence means the document predates the counters rather than that nothing was rejected.
 */
export interface LspHintRejections {
/**
 * Hover requests that answered without a text payload the pass could read. The request itself succeeded, so it is counted in requestsIssued and in neither failure counter.
 */
unparseableHover: number
/**
 * Hover text the pass read but could not attribute to a class: either no owner class name appears in it, or the name it names is not a class in the Symbol table.
 */
ownerClassNotFound: number
/**
 * Hover text naming an owner class the Symbol table has, but whose member the table does not — typically a method inherited from a dependency the scan never read.
 */
memberNotFound: number
/**
 * Call sites where a hint was found for the line but its receiver kind is not the one the call site writes. Hints are keyed by file and line, so a line holding both a this. and a super. call offers each of them the other's hint; the resolver declines rather than emitting an edge the hover never justified.
 */
kindMismatch: number
/**
 * Call sites whose hint named a Symbol dropped by a Category B/C rule. A dropped Symbol carries an empty body and zeroed fingerprints, so an edge into it would misstate what the caller reaches.
 */
targetDropped: number
}
/**
 * Aggregate call-resolution outcome counters (call-resolution.md §8.1). Class B per ir-schema.md §1.1, optional so documents produced before the field existed stay valid; the current scan pipeline always emits it, even when the workspace contains no call sites at all, so absence means "this document predates the counter" rather than "nothing was unresolved".
 */
export interface CallResolutionStats {
/**
 * Call sites present in symbols[].calls[]. Calls promoted to Symbol.effects[] by an effect plugin and calls removed by Category C drop rules never reach calls[] and are therefore not counted; dropped Symbols carry an empty calls[] and so contribute nothing. Denormalized for display — it always equals resolvedCalls plus the five unresolved buckets, and integrity invariant #15 enforces that.
 */
totalCalls: number
/**
 * Call sites the resolver identified a callee Symbol for (Call.resolved is non-null).
 */
resolvedCalls: number
unresolved: UnresolvedCallBuckets
}
/**
 * Why the remaining call sites stayed null, bucketed per call-resolution.md §8.1. The five counters sum to totalCalls - resolvedCalls.
 */
export interface UnresolvedCallBuckets {
/**
 * The callee identifier shadows a caller-local binding, so it names a runtime value rather than a Symbol (§4.2).
 */
localScope: number
/**
 * The callee is bound by an import whose specifier is not relative — a bare package specifier, a path alias, or a workspace package.
 */
external: number
/**
 * The receiver is not a name the untyped tier can follow: an expression receiver (`getRepo().save()`), or `this` / `super` with no LSP hint (§4.7).
 */
dynamic: number
/**
 * More than one candidate matched in some resolution tier, so the resolver declined to pick one (§7.1).
 */
ambiguous: number
/**
 * No candidate was found at all — a typo, or a callee that is neither imported nor present in the workspace.
 */
noMatch: number
}
/**
 * No `detail`. The scan carries one on `ScanResult.skipped` — the size, the elapsed, the message a plugin refused the file with — but an `unreadable` detail is a Node error message containing the absolute path, and a canonical document whose bytes depend on where the repository is checked out is not byte-stable.
 */
export interface SkippedFile {
/**
 * Workspace-relative POSIX path, NFC, the same form SourceRange.file uses.
 */
path: string
/**
 * Why the scan stopped working on this file. `over-size` and `unroutable` are decided before it was read, `unreadable` by either discovery or the read before extraction, and `parse-failed` / `parse-timeout` / `extraction-failed` during extraction. `unroutable` means no route into the Document exists for the file: either no loaded plugin claims its extension, or a segment of its path holds `:` or `#` and so cannot be part of a Symbol id (§3.1) — both decided without reading it, and the path itself says which, since the second case is visible in it. A reader distinguishes the reasons because they call for different actions: `parse-timeout` is machine-dependent and says re-run, `parse-failed` and `extraction-failed` are deterministic and say fix something.
 */
reason: ("over-size" | "unreadable" | "unroutable" | "parse-failed" | "parse-timeout" | "extraction-failed")
}
