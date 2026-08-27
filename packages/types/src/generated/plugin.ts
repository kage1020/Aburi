// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.plugin.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
/**
 * Plugin manifest declaring extension vocabulary contributed to Aburi. Validated at plugin load time.
 */
export interface PluginManifest {
$schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json"
/**
 * ASCII kebab-case plugin name (e.g., 'effects-prisma', 'framework-nestjs', 'lang-typescript').
 */
name: string
/**
 * (type=effects only) Identifier used as the x-<xPrefix> prefix for owned effect ids. Defaults to <name> with leading 'effects-' stripped. Example: name='effects-prisma' → xPrefix='prisma' → owned ids: 'x-prisma:*'.
 */
xPrefix?: string
/**
 * Semver.
 */
version: string
/**
 * Plugin role.
 */
type: ("lang" | "effects" | "framework")
engines: {
/**
 * Semver range of compatible Aburi core.
 */
aburi: string
}
provides: Provides
capabilities?: Capabilities
}

export interface Provides {
effects: EffectVocab[]
/**
 * Plugin-owned x-<ns> prefixes. The plugin may emit any x-<ns>:<action> under these at extraction time without enumerating each id.
 */
effectPrefixes: string[]
extKinds: ExtKindVocab[]
/**
 * Plugin-owned extKind prefixes. Minimum 2 segments (e.g., 'framework:nestjs', not just 'framework'). The plugin may emit <prefix>:<extra> at extraction time without enumerating each id.
 */
extKindPrefixes: string[]
derivedByPrefixes: string[]
frameworks: string[]
}
export interface EffectVocab {
/**
 * Plugin-extension effect id. Format: x-<plugin-namespace>:<action>
 */
id: string
description: string
}
export interface ExtKindVocab {
/**
 * Multi-segment extKind id.
 */
id: string
/**
 * Nearest core SymbolKind that consumers without this extension can fall back to.
 */
baseKind: ("function" | "method" | "class" | "interface" | "type" | "const" | "module" | "namespace" | "variable" | "enum" | "constructor" | "call")
description: string
}
/**
 * Optional runtime capabilities the plugin advertises. Source-of-truth for CLI concurrency budgets (lang-plugin.md §8.1, cli-spec.md §11).
 */
export interface Capabilities {
/**
 * (type=lang only) Expected WASM heap usage per parser worker in MiB. Aburi CLI multiplies this by concurrency to size the per-process budget and refuses to oversubscribe.
 */
wasmHeapPerWorkerMB?: number
}
