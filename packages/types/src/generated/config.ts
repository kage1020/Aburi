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
 * Per-file parse timeout (parse + extract + walk combined). Files exceeding this are aborted and recorded as skipped. Default 5000 ms.
 */
parseTimeoutMs?: number
/**
 * Per-call timeout for effect plugin classify(). Exceeding calls fall through to next plugin and are recorded in stats.effectClassifyTimeouts[]. Default 50 ms; raise to 200-500 for SQL/regex-heavy effect plugins.
 */
classifyTimeoutMs?: number
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
