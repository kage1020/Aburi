import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { type StageResult, type SymbolPair, stageResult } from "./pairing"

export function matchStageId(base: readonly IRSymbol[], head: readonly IRSymbol[]): StageResult {
  const headById = new Map<SymbolId, IRSymbol>()
  for (const symbol of head) headById.set(symbol.id, symbol)
  const matched: SymbolPair[] = []
  for (const baseSymbol of base) {
    const headSymbol = headById.get(baseSymbol.id)
    if (headSymbol !== undefined) {
      matched.push({ base: baseSymbol, head: headSymbol, rationale: "id-match" })
    }
  }
  return stageResult(matched, base, head)
}
