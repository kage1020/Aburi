import { type CandidateOverrides, makeCandidate as makeSharedCandidate } from "@aburi/test-support"
import type { SymbolCandidate } from "@aburi/types"

export { makeExtractionCtx as makeCtx } from "@aburi/test-support"

export function makeCandidate(overrides: CandidateOverrides): SymbolCandidate<unknown> {
  return makeSharedCandidate(overrides, { visibility: "internal" })
}
