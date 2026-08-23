// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.config.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
/**
 * Manifest name (e.g., 'effects-prisma'), npm package id ('@scope/pkg'), or relative path ('./aburi-plugins/x.mjs').
 */
export type PluginRef = string
export type RelativePath = string

/**
 * aburi.json / aburi.jsonc project configuration. All fields optional; empty config is valid (autodetect handles everything).
 */
export interface Config {
$schema?: "https://aburi.dev/schema/aburi.config.v1.json"
/**
 * Glob patterns added to drop-list category A (file-level skip). POSIX, workspace-root relative.
 */
ignore?: string[]
/**
 * Whether to merge .gitignore patterns into drop-list category A.
 */
respectGitignore?: boolean
/**
 * Enabled language plugins (manifest names or relative paths).
 */
languages?: PluginRef[]
/**
 * Enabled framework plugins. Order has no semantic effect.
 */
frameworks?: PluginRef[]
/**
 * Enabled effect plugins. Order determines first-match-wins priority.
 */
effects?: PluginRef[]
/**
 * Per-plugin opaque options keyed by manifest name.
 */
pluginOptions?: {
[k: string]: unknown | undefined
}
components?: ComponentOverride[]
/**
 * Identifier prefixes added to drop-list category C call drop.
 */
suppress?: string[]
/**
 * Identifier prefixes or decorator names that escape drop. Wins over suppress and plugin/core drop rules.
 */
keep?: string[]
frameworkHints?: FrameworkHint[]
output?: {
/**
 * Where scan and diff write their artifacts, and where explain reads the IR back from. Resolved against the working directory, as --output-dir is; --output-dir wins when both are given. May be absolute, which is why this is not a RelativePath.
 */
dir?: string
}
/**
 * If true, undeclared vocab emitted by plugins aborts extraction. If false, warnings are written to out/aburi-vocab-discovered.json.
 */
strict?: boolean
/**
 * Files exceeding this size are skipped during scan to protect WASM heap. Default 2 MB.
 */
maxFileSizeBytes?: number
/**
 * Smallest share of discovered files a scan may parse and still exit 0. Absent by default: a scan that parsed at least one file passes whatever it lost. Set it and `aburi scan` exits 3 when parsedFiles / totalFiles falls below it, counting every skip reason. A workspace that discovers nothing, or parses nothing, exits 3 with or without this key.
 */
minParsedFileRatio?: number
/**
 * Per-file parse timeout (parse + extract + walk combined). Files exceeding this are aborted and recorded as skipped. Default 5000 ms.
 */
parseTimeoutMs?: number
/**
 * Per-call timeout for effect plugin classify(). Exceeding calls fall through to next plugin and are recorded in stats.effectClassifyTimeouts[]. Default 50 ms; raise to 200-500 for SQL/regex-heavy effect plugins.
 */
classifyTimeoutMs?: number
/**
 * Optional LSP enrichment (docs/design/lsp-enrichment.md). Opt-in per-language; default off. Refines SourceRange columns, this./super./interface call resolution, Signature.inferredThrows, and CallEdge.confidence.
 */
lsp?: {
/**
 * Master switch. When false the enrichment pass is a total no-op regardless of servers.
 */
enabled?: boolean
/**
 * Per-language server config. Keys are language short-form ids (typescript, python, go, …).
 */
servers?: {
[k: string]: LspServerConfig | undefined
}
}
}
export interface ComponentOverride {
id: string
name?: string
/**
 * @minItems 1
 */
roots: RelativePath[]
publicApi?: string[]
languages?: string[]
frameworks?: string[]
description?: (string | null)
}
export interface FrameworkHint {
/**
 * Identifier used as the auto-registered ad-hoc plugin name and as Component.frameworks[] value.
 */
name: string
/**
 * Keyed by decorator name (e.g., 'AcmeController').
 */
decorators?: {
[k: string]: HintRule | undefined
}
/**
 * Keyed by class name glob pattern (e.g., '*Handler').
 */
classNamePatterns?: {
[k: string]: HintRule | undefined
}
}
export interface HintRule {
/**
 * Override Decorator.boundary for matching decorators. Ignored for classNamePatterns.
 */
boundary?: boolean
/**
 * Set Symbol.extKind for matching symbols. Must start with 'framework:' and have at least three segments ('framework:<vendor>:<kind>'); the loader injects 'hint' as the second segment so the resulting ownership prefix is unique per hint name. Writing 'framework:hint:*' directly is rejected at load time.
 */
extKind?: string
/**
 * Append to Symbol.derivedBy[].
 */
derivedBy?: string
/**
 * If true, drop matching symbol as Category B with dropReason set from name.
 */
drop?: boolean
}
export interface LspServerConfig {
/**
 * Server binary. PATH-resolvable or absolute path. Missing binaries trigger per-language fallback (lsp-enrichment.md §6.1).
 */
command: string
/**
 * Arguments passed to the server binary (e.g., ['--stdio']).
 */
args?: string[]
/**
 * Handshake timeout (lsp-enrichment.md §4.4). Default 10 s absorbs cold-disk starts.
 */
initializeTimeoutMs?: number
/**
 * Per-request timeout. Exceeding requests fall back per-request (lsp-enrichment.md §6.1). Default 500 ms.
 */
requestTimeoutMs?: number
/**
 * Per-file budget across all requests for that file. Exceeding triggers per-file fallback. Default 2000 ms.
 */
fileBudgetMs?: number
/**
 * Max in-flight requests per file (lsp-enrichment.md §4.3).
 */
concurrency?: number
/**
 * Opaque object forwarded verbatim to the server's initialize.initializationOptions. Server-specific; outside Aburi's compatibility scope.
 */
initializationOptions?: {
[k: string]: unknown | undefined
}
}
