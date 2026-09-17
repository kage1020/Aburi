import {
  type CandidateOverrides,
  makeExtractionCtx,
  makeCandidate as makeSharedCandidate,
} from "@aburi/test-support"
import type { ExtractionContext, SymbolCandidate } from "@aburi/types"

export function makeCtx(path = "src/a.tsx", content = ""): ExtractionContext {
  return makeExtractionCtx(path, content)
}

export function makeCandidate(overrides: CandidateOverrides): SymbolCandidate<unknown> {
  return makeSharedCandidate(overrides, { filePath: "src/a.tsx" })
}
