// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.diff.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
import type { Component, Dependency, Symbol } from "./ir"
export type { Component, Dependency, Symbol } from "./ir"
export type SymbolChange = (SymbolAdded | SymbolRemoved | SymbolMoved | SymbolChanged | SymbolMovedChanged | SymbolDroppedToggled)
export type MatchRationale = ("id-match" | "git-rename" | "logic-fingerprint" | "logic-fingerprint+name-disambiguation" | "name-signature" | "dropped-weak-match")

/**
 * Result of aburi diff <base>..<head>. JSON projection of the matched/added/removed/moved/changed symbol pairs.
 */
export interface DiffResult {
$schema: "https://aburi.dev/schema/aburi.diff.v1.json"
generator: Generator
base: IRRef
head: IRRef
summary: Summary
symbols: SymbolChange[]
components: ComponentDiff
dependencies: DependencyDiff
}
export interface Generator {
name: string
version: string
}
export interface IRRef {
/**
 * Git ref, file path, or other identifier of the IR source.
 */
ref: string
/**
 * Schema id of the input IR. Must match between base and head.
 */
irSchema: string
}
export interface Summary {
added: number
removed: number
moved: number
movedChanged: number
changed: number
droppedToggled: number
unchanged: number
droppedAdded: number
droppedRemoved: number
componentsAdded: number
componentsRemoved: number
componentsChanged: number
depsAdded: number
depsRemoved: number
}
export interface SymbolAdded {
status: "added"
symbol: Symbol
}
export interface SymbolRemoved {
status: "removed"
symbol: Symbol
}
export interface SymbolMoved {
status: "moved"
before: Symbol
after: Symbol
rationale: MatchRationale
}
export interface SymbolChanged {
status: "changed"
before: Symbol
after: Symbol
delta: SymbolDelta
}
export interface SymbolDelta {
apiChanged: boolean
logicChanged: boolean
syntaxChanged: boolean
componentChanged: boolean
visibilityChanged: boolean
rules?: ArrayDelta
effects?: ArrayDelta
calls?: ArrayDelta
decorators?: ArrayDelta
signature?: (SignatureDelta | null)
}
export interface ArrayDelta {
added: unknown[]
removed: unknown[]
modified: unknown[]
}
export interface SignatureDelta {
inputs: ArrayDelta
outputs: ArrayDelta
throws: ArrayDelta
asyncChanged: boolean
generatorChanged: boolean
typeParametersChanged: boolean
}
export interface SymbolMovedChanged {
status: "moved+changed"
before: Symbol
after: Symbol
rationale: MatchRationale
delta: SymbolDelta
}
export interface SymbolDroppedToggled {
status: "dropped-toggled"
before: Symbol
after: Symbol
direction: ("to-dropped" | "to-kept")
}
export interface ComponentDiff {
added: Component[]
removed: Component[]
changed: {
before: Component
after: Component
delta: {
rootsChanged: boolean
publicApiChanged: boolean
frameworksChanged: boolean
}
}[]
}
export interface DependencyDiff {
added: Dependency[]
removed: Dependency[]
}
