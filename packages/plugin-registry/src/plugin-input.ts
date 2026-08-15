// Fail-fast guards over the values a language plugin hands to an effect plugin.
//
// Deliberately import-light: this module pulls in nothing but a type from `@aburi/types`,
// which is what lets it ship as the `@aburi/plugin-registry/plugin-input` subpath without
// dragging the barrel's eager ajv schema compilation into every effect plugin's startup.
// Keep it that way — a value import from a sibling module here would silently undo it.

import type { ImportEdge } from "@aburi/types"

/**
 * A `.`-split callee target that has been checked for emptiness. The tuple shape records
 * that the first segment exists, so callers index it without a cast under
 * `noUncheckedIndexedAccess`.
 */
export type NonEmptySegments = readonly [string, ...string[]]

/**
 * Who is asking, and about which file. Threaded into every thrown message so a caught
 * exception in production tooling (CI logs, error reporters) points at the offending
 * source file instead of a bare "empty target" string.
 *
 * Passed as a record rather than two positional strings: `plugin` and `filePath` are both
 * plain strings, so a positional pair would let a transposed call type-check and only
 * surface as a scrambled error message at the worst possible moment.
 */
export interface PluginInputOrigin {
  /** Plugin name used as the message prefix, e.g. `"effects-drizzle"`. */
  readonly plugin: string
  /** Path of the source file the candidate came from. */
  readonly filePath: string
}

/**
 * The two views of a validated target that classifiers actually consume: the full segment
 * list, and the terminal segment they dispatch on. Returning `last` separately is what
 * removes the `parts.at(-1) as string` cast from every call site — `at()` widens to
 * `string | undefined` even on a tuple.
 */
export interface CallTargetSegments {
  readonly segments: NonEmptySegments
  readonly last: string
}

/**
 * Split `target` on `.` and reject any shape a well-formed language plugin would never
 * emit: an empty target, or one with an empty segment (leading, trailing, or adjacent
 * dots). A malformed target would otherwise slip through a classifier's length gate and
 * false-classify — `"prisma..create"` has three segments and would match a write verb.
 *
 * **Call this before the plugin's import gate, not after.** Both orders detect the same
 * violations, but gating first narrows detection to the files that import the plugin's
 * library — so an upstream normalization bug reproduces only in that slice and looks
 * library-specific instead of what it is. Checking first does not reach every file either
 * (a dropped symbol or a category-C call never gets classified at all), but it removes the
 * one bias that would actively mislead whoever debugs it.
 *
 * A thrown error is an upstream contract violation, not a classification decision, and
 * effect-plugin.md §10 EP3a exempts it from the "a throwing classifier is treated as
 * `null`" rule: it propagates and fails the scan. Degrading it would convert a language
 * plugin bug into a quietly under-populated IR.
 */
export function assertNonEmptySegments(
  target: string,
  origin: PluginInputOrigin,
): CallTargetSegments {
  const where = `${origin.plugin} (${origin.filePath})`
  if (target.length === 0) {
    throw new Error(
      `${where}: CallCandidate.target is empty — language plugin emitted an unnormalized callee`,
    )
  }

  // The `= ""` default is what narrows `first` to `string` without a cast, and it needs no
  // branch of its own: `String.prototype.split` never returns an empty array, and if it
  // somehow did, the empty default falls straight into the empty-segment rejection below.
  const [first = "", ...rest] = target.split(".")

  const emptySegment = `${where}: CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`
  if (first.length === 0) throw new Error(emptySegment)

  // `last` is carried through the validation loop rather than read back by index: a
  // trailing-index read widens to `string | undefined` under noUncheckedIndexedAccess even
  // on a tuple, and re-introducing a cast here would defeat the point of this function.
  let last = first
  for (const segment of rest) {
    if (segment.length === 0) throw new Error(emptySegment)
    last = segment
  }

  return { segments: [first, ...rest], last }
}

/**
 * Reject an import edge the language plugin should never have emitted: a module specifier
 * of zero length. Nothing downstream can act on it — it names no module, so a provenance
 * check would silently answer "not from my package" and an unresolved-import diagnostic
 * would name nothing.
 *
 * Callers that walk the edge list themselves must call this on every edge **before**
 * answering, not just on the ones they end up using: an answer that depends on which edges
 * a predicate happened to reach makes the throw depend on import order.
 */
export function assertImportEdgeSource(edge: ImportEdge, origin: PluginInputOrigin): void {
  if (edge.source.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
  )
}

/**
 * The two halves of one `ImportEdge.symbols` entry, as the caller recovered them.
 *
 * Taken as a parameter rather than split here: the wire format's parser lives in
 * `@aburi/core` (`splitAliasedImportName`), and importing a value from it would fold this
 * module back into the barrel's graph — the one thing the header forbids. Callers already
 * hold the split, so passing it costs nothing and keeps the format's definition in one place.
 */
export interface ImportBindingHalves {
  readonly imported: string
  readonly local: string
}

/**
 * Reject a `symbols` entry whose exported or local half is empty — `" as Y"`, `"X as "`, or
 * an entry that is empty outright.
 *
 * An empty half is not a name, and a plugin that matches names against a vocabulary table
 * will look up `""`, miss every entry, and drop the classification with nothing recording
 * that anything was skipped. That is the same disappearing act `assertImportEdgeSource`
 * refuses for a module specifier, arriving through the other field of the same edge — and
 * unlike a specifier, an empty half can take a whole class's `extKind` with it, because the
 * decorator it belongs to stops matching.
 *
 * Guarding only the local half is not enough. The exported half is the one that reaches the
 * table, and a caller that skips an entry on an empty local name hands the written name back
 * to its own "no edge mentions this" branch, which is generally the most trusting one.
 */
export function assertImportBinding(
  binding: ImportBindingHalves,
  raw: string,
  edge: ImportEdge,
  origin: PluginInputOrigin,
): void {
  if (binding.imported.length > 0 && binding.local.length > 0) return
  throw new Error(
    `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
  )
}

/**
 * True when any import edge's module specifier satisfies `matches`, after every edge has
 * been checked for an empty `source`.
 *
 * The validation pass runs across the whole list *before* the match check, so throw
 * behaviour does not depend on import order — a `.some()` that validated inline would
 * short-circuit on the first match and never notice a broken edge sitting behind it.
 * Bundling the two passes into one function is what makes that ordering unforgeable:
 * there is no way to ask "does this file import X?" while skipping the validation.
 *
 * `matches` receives the specifier string alone rather than the whole `ImportEdge`. Not
 * for safety — validation has already run over every edge by the time the predicate is
 * called, so a wider argument could not skip it. It is the smaller surface: every current
 * caller matches on the specifier, and widening the argument later stays compatible while
 * narrowing it would not.
 */
export function hasMatchingImport(
  imports: readonly ImportEdge[],
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  for (const edge of imports) assertImportEdgeSource(edge, origin)
  return imports.some((edge) => matches(edge.source))
}
