import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { extractFile } from "@aburi/test-harness"
import type { CandidateOverrides } from "@aburi/test-support"
import { makeExtractionCtx, makeCandidate as makeSharedCandidate } from "@aburi/test-support"
import type { ExtractionContext, SymbolCandidate } from "@aburi/types"

export function makeCtx(path = "src/a.tsx", content = ""): ExtractionContext {
  return makeExtractionCtx(path, content)
}

export function makeCandidate(overrides: CandidateOverrides): SymbolCandidate<unknown> {
  return makeSharedCandidate(overrides, { filePath: "src/a.tsx" })
}

/** The Symbol the TypeScript plugin extracts from `source` under `name`, nodes and all. */
export async function candidateNamed(
  source: string,
  name: string,
  path = "src/f.tsx",
): Promise<SymbolCandidate<unknown>> {
  const { candidates } = await extractFile(langTypescriptPlugin, path, source)
  const found = candidates.find((candidate) => candidate.name === name)
  if (found === undefined) {
    throw new Error(`no Symbol named ${name}; have ${candidates.map((c) => c.name).join(", ")}`)
  }
  return found
}
