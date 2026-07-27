/**
 * Per-run diagnostics that deliberately do NOT live in the IR.
 *
 * `call-resolution.md` §8.1 keeps the "why was this call not resolved" reason
 * out of `aburi.ir.v1` on purpose: it is debugging output that only matters
 * while investigating one specific outcome, and persisting it would enlarge
 * every document and drag the reason into fingerprint territory. The aggregate
 * counts DO land in `IR.stats.callResolution`; these records are the detail
 * behind those counts, passed in memory from the scan to whoever asked for it.
 */

import type { SymbolId } from "./generated/ir"

/**
 * Why the resolver declined to identify a callee. Spelled exactly as the
 * `call-resolution.md` §8.1 bucket table spells it; `UnresolvedCallBuckets` in
 * the IR schema carries the same five values under camelCase property names.
 */
export type UnresolvedCallBucket = "local-scope" | "external" | "dynamic" | "ambiguous" | "no-match"

/** One call site the resolver left `resolved: null`, with its §8.1 bucket. */
export interface UnresolvedCallDiagnostic {
  symbolId: SymbolId
  target: string
  line: number
  bucket: UnresolvedCallBucket
  /**
   * The competing candidates that made the call `ambiguous`, deduplicated and
   * lex-sorted (§10.4 CR29). Empty for every other bucket.
   */
  candidates: readonly SymbolId[]
}
