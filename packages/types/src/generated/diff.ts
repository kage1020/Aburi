// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.diff.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
import type { Component, Dependency, Symbol, SymbolId } from "./ir"
export type { Component, Dependency, Symbol, SymbolId } from "./ir"
export type SymbolChange = (SymbolAdded | SymbolRemoved | SymbolMoved | SymbolChanged | SymbolMovedChanged | SymbolDroppedToggled | SymbolUnknown)
export type MatchRationale = ("id-match" | "git-rename" | "logic-fingerprint" | "logic-fingerprint+name-disambiguation" | "name-signature" | "dropped-weak-match")
/**
 * Cluster id: "slice:" + the anchor, which is members[0]. Derived, not independent: read members[0] for the anchor rather than stripping this prefix. The pattern checks the prefix only — the derivation itself has no JSON Schema equivalent and is enforced by the producer.
 */
export type SliceId = string & { readonly __brand: "SliceId" }
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
/**
 * Weakly-connected components of changed Symbols over the call graph (see docs/design/slice-view.md).
 */
slices: SliceRecord[]
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
/**
 * Symbols whose fate could not be determined because one document never analysed their file. Optional rather than required so a diff written before the counter existed stays valid; absence means "this document predates the counter", not "nothing was unknown".
 */
unknown?: number
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
/**
 * `symbol` is the entry as the document that does have it records it. A Symbol present in one document and absent from the other, where the absent side never analysed the file it lives in — `stats.skippedFiles[]` names that file. Not `added` or `removed`: nothing was written or deleted, the evidence is missing. Reporting it as either is the failure this status exists to prevent, because a scan that dropped a file would otherwise produce a confident report of API the author never touched.
 */
export interface SymbolUnknown {
status: "unknown"
symbol: Symbol
/**
 * Which document lacks it, which is the same document that lost the file. `head` reads as "this may still exist", `base` as "this may not be new".
 */
absentFrom: ("base" | "head")
/**
 * Why that document skipped the file, copied from its `stats.skippedFiles[]`. It decides what the reader does next: `parse-timeout` is machine-dependent and says re-run, `parse-failed` and `extraction-failed` are deterministic and say fix something.
 */
reason: ("over-size" | "unreadable" | "unroutable" | "parse-failed" | "parse-timeout" | "extraction-failed")
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
export interface SliceRecord {
id: SliceId
/**
 * Member Symbol ids in strictly ascending lexicographic order. members[0] is the Slice anchor.
 * 
 * @minItems 1
 */
members: SymbolId[]
}
