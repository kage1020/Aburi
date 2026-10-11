import { trySymbolId } from "@aburi/core"
import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { type StageResult, type SymbolPair, stageResult } from "./pairing"

export type GitRenameMap = ReadonlyMap<string, string>

export function matchStageGitRename(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
  renameMap: GitRenameMap | null,
): StageResult {
  if (renameMap === null || renameMap.size === 0) {
    return stageResult([], remainingBase, remainingHead)
  }
  const headById = new Map<SymbolId, IRSymbol>()
  for (const symbol of remainingHead) headById.set(symbol.id, symbol)

  const claimants = new Map<SymbolId, { head: IRSymbol; bases: [IRSymbol, ...IRSymbol[]] }>()
  for (const baseSymbol of remainingBase) {
    const newPath = renameMap.get(baseSymbol.source.file)
    if (newPath === undefined) continue
    const expectedId = rewriteIdFile(baseSymbol.id, baseSymbol.source.file, newPath)
    if (expectedId === null) continue
    const head = headById.get(expectedId)
    if (head === undefined) continue
    const claim = claimants.get(expectedId)
    if (claim === undefined) claimants.set(expectedId, { head, bases: [baseSymbol] })
    else claim.bases.push(baseSymbol)
  }

  const matched: SymbolPair[] = []
  for (const { head, bases } of claimants.values()) {
    matched.push({ base: lowestId(bases), head, rationale: "git-rename" })
  }
  return stageResult(matched, remainingBase, remainingHead)
}

function lowestId(symbols: readonly [IRSymbol, ...IRSymbol[]]): IRSymbol {
  let lowest = symbols[0]
  for (const symbol of symbols) {
    if (symbol.id < lowest.id) lowest = symbol
  }
  return lowest
}

function rewriteIdFile(id: SymbolId, oldPath: string, newPath: string): SymbolId | null {
  const colon = id.indexOf(":")
  const hash = id.indexOf("#")
  if (colon < 0 || hash < 0 || hash < colon) return id
  const filePart = id.slice(colon + 1, hash)
  if (filePart !== oldPath) return id
  return trySymbolId({
    language: id.slice(0, colon),
    file: newPath,
    qualifiedName: id.slice(hash + 1),
  })
}
