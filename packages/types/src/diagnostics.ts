import type { SymbolId } from "./generated/ir"

export type UnresolvedCallBucket = "local-scope" | "external" | "dynamic" | "ambiguous" | "no-match"

export interface UnresolvedCallDiagnostic {
  symbolId: SymbolId
  target: string
  line: number
  bucket: UnresolvedCallBucket
  candidates: readonly SymbolId[]
}
