/** The separator every key in this module joins its components with. */
export const CALL_SITE_KEY_SEPARATOR = "\t"

/** Identity of a `Dependency`: the `(from, to, via)` triple ir-schema.md #13 makes unique. */
export function dependencyKey(from: string, to: string, via: string): string {
  return [from, to, via].join(CALL_SITE_KEY_SEPARATOR)
}

/** Identity of a call-graph edge, where `via` is fixed to `"call"` (ir-schema.md #14). */
export function callEdgeKey(from: string, to: string): string {
  return [from, to].join(CALL_SITE_KEY_SEPARATOR)
}

/**
 * Identity of one call site for the side channels that cannot ride along in the
 * IR: `dynamicCallSites` on the way into the resolver, and the LSP pass's
 * `receiverHints` on the way out of enrichment.
 *
 * `line` alone would collide on `a().b(c().d())`; adding the normalized target
 * separates the two. For a hint channel that collision is not a near-miss but a
 * fabricated edge: a hint filed under the line alone is applied to whatever else
 * shares that line, so an unrelated callee resolves to the hinted method, the
 * call vanishes from the `unresolved` diagnostics, and a `Dependency` no source
 * line justifies lands in the IR. One key function serves both channels so the
 * two can never drift apart again.
 *
 * The key survives the re-sorts the extraction pipeline applies to `calls[]` —
 * `byTargetThenLine` and then the stable re-sort by line that `pipeline.ts`
 * needs for its monotonic-`.line` invariant — because it depends on neither
 * position nor order.
 */
export function makeCallSiteKey(file: string, line: number, target: string): string {
  return [file, line, target].join(CALL_SITE_KEY_SEPARATOR)
}

/**
 * The receiver segment of a normalized call target: `"this"` for `this.foo`,
 * `"super"` for `super.foo`, and whatever else the target leads with otherwise.
 *
 * It lives beside `makeCallSiteKey` for the same reason that function does. A
 * receiver hint is a handshake between the LSP pass and the resolver over two
 * derived values — the key, and the `kind` checked against it — and a hint is
 * discarded silently when either side disagrees. Deriving `kind` here on the
 * producing side and comparing it here on the consuming side means one edit
 * moves both, so `this?.foo` or a leading dot cannot start meaning two things.
 */
export function receiverHead(target: string): string | undefined {
  return target.split(".").find((segment) => segment.length > 0)
}
