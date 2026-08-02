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
 * Callers should treat a thrown error as an upstream contract violation, not a
 * classification decision. `@aburi/core` does not catch it, so it surfaces to the user
 * rather than silently miscategorizing a call.
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

  const [first, ...rest] = target.split(".")
  if (first === undefined) {
    // Unreachable: `String.prototype.split` never returns an empty array, and the empty
    // target is already rejected above. The branch exists only so `first` narrows to
    // `string` without a cast, which is what makes the tuple below provable.
    throw new Error(
      `${where}: internal invariant violated — String.split returned no segments for "${target}"`,
    )
  }

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
 * True when any import edge's module specifier satisfies `matches`, after every edge has
 * been checked for an empty `source`.
 *
 * The validation pass runs across the whole list *before* the match check, so throw
 * behaviour does not depend on import order — a `.some()` that validated inline would
 * short-circuit on the first match and never notice a broken edge sitting behind it.
 * Bundling the two passes into one function is what makes that ordering unforgeable:
 * there is no way to ask "does this file import X?" while skipping the validation.
 *
 * `matches` receives the specifier string alone rather than the whole `ImportEdge` for the
 * same reason — a predicate that could reach other fields would be a way around the check.
 */
export function hasMatchingImport(
  imports: readonly ImportEdge[],
  origin: PluginInputOrigin,
  matches: (source: string) => boolean,
): boolean {
  for (const edge of imports) {
    if (edge.source.length === 0) {
      throw new Error(
        `${origin.plugin} (${origin.filePath}, line ${edge.line}): ImportEdge.source is empty — language plugin emitted an unnormalized import edge`,
      )
    }
  }
  return imports.some((edge) => matches(edge.source))
}
