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
 * The key survives the `(target, line)` re-sort the extraction pipeline applies
 * to `calls[]` because it depends on neither position nor order.
 */
export function makeCallSiteKey(file: string, line: number, target: string): string {
  return `${file}\t${line}\t${target}`
}
