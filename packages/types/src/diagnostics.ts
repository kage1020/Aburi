import type { SymbolId } from "./generated/ir"

export type UnresolvedCallBucket = "local-scope" | "external" | "dynamic" | "ambiguous" | "no-match"

/** One call site the resolver left `resolved: null`, with its `call-resolution.md` bucket. */
export interface UnresolvedCallDiagnostic {
  symbolId: SymbolId
  target: string
  line: number
  bucket: UnresolvedCallBucket
  candidates: readonly SymbolId[]
}
