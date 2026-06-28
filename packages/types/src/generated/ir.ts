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
export type SymbolKind = ("function" | "method" | "class" | "interface" | "type" | "const" | "module" | "namespace" | "variable" | "enum" | "constructor")
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
async: boolean
generator: boolean
typeParameters: string[]
}
export interface Effect {
id: EffectId
target: string
line: number
plugin: string
confidence: Confidence
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
 * Effect 分類が classifyTimeoutMs を超えて打ち切られた件の記録 (effect-plugin.md §5.1.1)。空配列が原則。値があれば決定性ログとして残す。
 */
effectClassifyTimeouts?: EffectClassifyTimeout[]
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
