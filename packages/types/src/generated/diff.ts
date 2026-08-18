// AUTO-GENERATED — DO NOT EDIT.
// Source: schema/aburi.diff.v1.json
// Run `pnpm --filter @aburi/types codegen` to regenerate.
import type { Component, Dependency, Symbol, SymbolId } from "./ir"
export type { Component, Dependency, Symbol, SymbolId } from "./ir"
export type SymbolChange = (SymbolAdded | SymbolRemoved | SymbolMoved | SymbolChanged | SymbolMovedChanged | SymbolDroppedToggled | SymbolUnknown)
export type MatchRationale = ("id-match" | "git-rename" | "logic-fingerprint" | "logic-fingerprint+name-disambiguation" | "name-signature" | "dropped-weak-match")
/**
 * Why a scan skipped a file, copied from the IR's stats.skippedFiles[].reason. It decides what the reader does next: `parse-timeout` is machine-dependent and says re-run, `parse-failed` and `extraction-failed` are deterministic and say fix something. One definition for the two places this diff spells it — the cross-schema copy against aburi.ir.v1.json is a deliberate stance, the in-file one was not.
 */
export type SkipReason = ("over-size" | "unreadable" | "unroutable" | "parse-failed" | "parse-timeout" | "extraction-failed")
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
/**
 * Dependencies whose fate could not be determined, for the same reason and on the same terms as `unknown`. Counts `dependencies.unknown[]`, so `depsAdded` and `depsRemoved` exclude them.
 */
depsUnknown?: number
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
reason: SkipReason
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
/**
 * Edges one document holds that the other could not have, because it never analysed the file an endpoint lives in. Sorted by the same (from, to, via) key as added and removed. Optional only so a diff written before the field existed stays valid — a current writer always emits the key, empty array included, because 'nothing was unknown' and 'this writer could not say' are different answers and there is no arithmetic elsewhere in the document to tell them apart.
 */
unknown?: DependencyUnknown[]
}
/**
 * A Dependency present in one document and absent from the other, where the absent side never analysed the file one of its endpoints lives in. Not `added` or `removed`: dependencies[] is projected from the resolved call graph, so a withdrawn file takes every edge it participated in with it — including edges whose other end survived. Reporting those as deletions is the same confident-but-wrong report SymbolUnknown exists to prevent, one array over.
 */
export interface DependencyUnknown {
dependency: Dependency
/**
 * Which document lacks the edge, which is the same document that lost the file. `head` reads as "this may still exist", `base` as "this may not be new".
 */
absentFrom: ("base" | "head")
/**
 * The endpoint files that document skipped, sorted by path with no repeats. A list rather than the single `reason` SymbolUnknown carries, because an edge has two endpoints: they can live in two different files with two different reasons, and an intra-file edge collapses to one entry. Component-level endpoints never appear — a Component is an aggregate over roots and has no file to lose.
 * 
 * @minItems 1
 */
lostFiles: SkippedFile[]
}
/**
 * A file a scan never analysed, copied from the IR's stats.skippedFiles[]. Validated strictly here, which is NOT how the other borrowed types work: Symbol, Component and Dependency below are deliberate stubs that defer validation to aburi.ir.v1.json, and the codegen replaces them with a re-export from the IR module. This one is spelled out because a diff reader has to be able to reject a malformed entry without fetching a second schema, and because the value is two scalars rather than a whole record. The precedent is SkipReason above, already spelled inline in this file for SymbolUnknown.
 */
export interface SkippedFile {
/**
 * Workspace-relative POSIX path, NFC, the same form SourceRange.file uses. That is what puts it in the same space as symbols[].source.file, which is how an endpoint's file is matched against this list at all.
 */
path: string
reason: SkipReason
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
