import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { lastSegment } from "../similarity"
import { compareByEndpoints, type Endpoints, type StageResult, stageResult } from "./pairing"

export function matchStageDroppedWeak(
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): StageResult {
  const bases = remainingBase.filter((symbol) => symbol.dropped)
  const heads = remainingHead.filter((symbol) => symbol.dropped)

  const identified: Endpoints[] = []
  for (const keyOf of [nameKey, fileKey]) {
    identified.push(...pairsIdentifiedBy(bases, heads, keyOf))
  }

  const matched = maximumMatching(identified).map(({ base, head }) => ({
    base,
    head,
    rationale: "dropped-weak-match" as const,
  }))
  return stageResult(matched, remainingBase, remainingHead)
}

function maximumMatching(edges: readonly Endpoints[]): Endpoints[] {
  const ordered = [...edges].sort(compareByEndpoints)
  const atBase = new Map<SymbolId, number[]>()
  const atHead = new Map<SymbolId, number[]>()
  for (const [index, edge] of ordered.entries()) {
    appendTo(atBase, edge.base.id, index)
    appendTo(atHead, edge.head.id, index)
  }
  const adjacent = (index: number): number[] => {
    const edge = ordered[index]
    if (edge === undefined) return []
    const sharing = [...(atBase.get(edge.base.id) ?? []), ...(atHead.get(edge.head.id) ?? [])]
    return sharing.filter((other) => other !== index)
  }

  const walked = ordered.map(() => false)
  const matching: Endpoints[] = []
  const takeAlternateEdgesFrom = (start: number): void => {
    let step = start
    let take = true
    while (!walked[step]) {
      walked[step] = true
      const edge = ordered[step]
      if (take && edge !== undefined) matching.push(edge)
      take = !take
      const next = adjacent(step).find((other) => walked[other] === false)
      if (next === undefined) return
      step = next
    }
  }

  for (const [index] of ordered.entries()) {
    if (!walked[index] && adjacent(index).length <= 1) takeAlternateEdgesFrom(index)
  }
  for (const [index] of ordered.entries()) {
    if (!walked[index]) takeAlternateEdgesFrom(index)
  }
  return matching
}

function appendTo(table: Map<SymbolId, number[]>, key: SymbolId, index: number): void {
  const bucket = table.get(key)
  if (bucket === undefined) table.set(key, [index])
  else bucket.push(index)
}

function pairsIdentifiedBy(
  bases: readonly IRSymbol[],
  heads: readonly IRSymbol[],
  keyOf: (symbol: IRSymbol) => string,
): Endpoints[] {
  const soleBase = soleCarriers(bases, keyOf)
  const soleHead = soleCarriers(heads, keyOf)
  const pairs: Endpoints[] = []
  for (const [key, base] of soleBase) {
    const head = soleHead.get(key)
    if (head !== undefined) pairs.push({ base, head })
  }
  return pairs
}

function soleCarriers(
  symbols: readonly IRSymbol[],
  keyOf: (symbol: IRSymbol) => string,
): Map<string, IRSymbol> {
  const sole = new Map<string, IRSymbol>()
  const shared = new Set<string>()
  for (const symbol of symbols) {
    const key = keyOf(symbol)
    if (shared.has(key)) continue
    if (sole.has(key)) {
      sole.delete(key)
      shared.add(key)
      continue
    }
    sole.set(key, symbol)
  }
  return sole
}

function nameKey(symbol: IRSymbol): string {
  return `${symbol.kind}/${lastSegment(symbol.name)}`
}

function fileKey(symbol: IRSymbol): string {
  return `${symbol.kind}/${basename(symbol.source.file)}`
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}
