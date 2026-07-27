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
export type LanguageId = string
/**
 * ASCII kebab-case.
 */
export type ComponentId = string
export interface Symbol {
id: SymbolId
kind: SymbolKind
extKind: ExtKind
name: string
language: LanguageId
component?: (ComponentId | null)
visibility: Visibility
decorators: Decorator[]
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
export type SymbolId = string
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
line?: number
plugin: string
confidence: Confidence
/**
 * Evidence string from the effect plugin classifier (effect-plugin.md §4.4). Locally-detected entries carry the plugin's original value verbatim. On merge across propagation paths, the lexicographically-smallest string wins (effect-propagation.md §5.2).
 */
derivedBy: string
/**
 * True when the entry was produced by the effect-propagation pass (effect-propagation.md §5.1). Absent or false for locally-detected entries.
 */
propagated?: boolean
/**
 * Direct upstream callee Symbol id(s) that carried this (effectId, target) into the current Symbol. Sorted ascending. Present only when propagated=true.
 */
derivedFrom?: SymbolId[]
}
export type EffectId = (("db.read" | "db.write" | "db.transaction" | "db.migration" | "network.http" | "network.ws" | "network.rpc" | "queue.publish" | "queue.consume" | "event.publish" | "event.subscribe" | "fs.read" | "fs.write" | "state.mutate" | "collection.mutate" | "time.now" | "time.timer" | "random" | "env.read" | "env.write" | "process.exit" | "process.signal") | string)
export type Confidence = ("high" | "medium" | "low")

/**
 * Aburi intermediate representation (aburi.ir.v1). Source of truth for L3; L0-L2 Markdown views are derived deterministically from this.
 */
export interface IR {
$schema: "https://aburi.dev/schema/aburi.ir.v1.json"
generator: Generator
/**
 * ISO 8601 UTC. Excluded from fingerprint. Omit with --no-timestamp when committing IR.
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
 * Glob patterns or symbol ids that designate the component's public surface. POSIX (no backslash).
 */
publicApi?: string[]
/**
 * @minItems 1
 */
languages: LanguageId[]
frameworks?: string[]
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
 * Throws inferred from callees' declared signatures by the LSP enrichment pass (lsp-enrichment.md §7.1). Distinct from `throws` so LSP enablement never perturbs the `api` fingerprint. Optional AND omitted-when-empty: writers MUST omit the key entirely when nothing was inferred, never emit as [].
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
startColumn?: (number | null)
endColumn?: (number | null)
}
export interface Fingerprint {
api: string
logic: string
syntax: string
}
export interface Dependency {
from: string
to: string
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
 * Records effect classifications aborted after exceeding classifyTimeoutMs (effect-plugin.md §5.1.1). Empty in the normal case; non-empty entries are kept as a determinism log.
 */
effectClassifyTimeouts?: EffectClassifyTimeout[]
effectPropagation: EffectPropagationStats
lspEnrichment?: LspEnrichmentStats
callResolution?: CallResolutionStats
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
 * Optional bookkeeping from the LSP enrichment pass (lsp-enrichment.md §7.2). Present when the pass ran regardless of whether it succeeded or fell back; absent when config.lsp is not configured.
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
}
/**
 * Aggregate call-resolution outcome counters (call-resolution.md §8.1). Optional so documents produced before the field existed stay valid; the current scan pipeline always emits it, even when the workspace contains no call sites at all.
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
