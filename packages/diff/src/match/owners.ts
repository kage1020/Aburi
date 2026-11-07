import { compareCodeUnit } from "@aburi/core"
import type { Symbol as IRSymbol } from "@aburi/types"
import { ownerOf, ownersCorrespond } from "../similarity"
import type { SymbolPair } from "./pairing"

export type OwnerRefusal =
  | { readonly rule: "split"; readonly base: IRSymbol }
  | { readonly rule: "names" | "shared"; readonly base: IRSymbol; readonly head: IRSymbol }

export interface OwnerPairing {
  readonly matched: readonly SymbolPair[]
  readonly refusals: readonly OwnerRefusal[]
}

// No Symbol id is empty.
const NO_OWNER = ""

export function pairOwnersThroughMembers(
  paired: readonly SymbolPair[],
  remainingBase: readonly IRSymbol[],
  remainingHead: readonly IRSymbol[],
): OwnerPairing {
  const baseOwner = enclosingIn([...paired.map((pair) => pair.base), ...remainingBase])
  const headOwner = enclosingIn([...paired.map((pair) => pair.head), ...remainingHead])
  const pointsInto = new Map<string, string[]>()
  const comesFrom = new Map<string, Set<string>>()
  const record = (pair: SymbolPair): void => {
    const from = baseOwner(pair.base)?.id ?? NO_OWNER
    const into = headOwner(pair.head)?.id ?? NO_OWNER
    if (from !== NO_OWNER) appendTo(pointsInto, from, into)
    if (into === NO_OWNER) return
    const sources = comesFrom.get(into)
    if (sources === undefined) comesFrom.set(into, new Set([from]))
    else sources.add(from)
  }
  for (const pair of paired) record(pair)

  const freeHeads = new Map<string, IRSymbol>(
    remainingHead.filter(isCandidate).map((symbol) => [symbol.id, symbol]),
  )
  const partnerOfHead = new Map<string, string>()
  const matched: SymbolPair[] = []
  const refusals: OwnerRefusal[] = []
  // Deepest first, so a nested owner's pair is evidence for the owner holding it by that one's turn.
  for (const base of deepestFirst(remainingBase.filter(isCandidate))) {
    const targets = pointsInto.get(base.id)
    if (targets === undefined) continue
    const [target] = targets
    if (target === undefined || target === NO_OWNER || targets.some((into) => into !== target)) {
      refusals.push({ rule: "split", base })
      continue
    }
    const head = freeHeads.get(target)
    if (head === undefined || head.kind !== base.kind) continue
    if (!ownersCorrespond(base.name, head.name)) {
      refusals.push({ rule: "names", base, head })
      continue
    }
    if ((comesFrom.get(head.id)?.size ?? 0) > 1) {
      refusals.push({ rule: "shared", base, head })
      continue
    }
    // The head's owner was paired on the members it held, and this would give it one from elsewhere.
    const holder = headOwner(head)
    const holderPartner = holder === undefined ? undefined : partnerOfHead.get(holder.id)
    if (holderPartner !== undefined && holderPartner !== baseOwner(base)?.id) continue
    freeHeads.delete(head.id)
    partnerOfHead.set(head.id, base.id)
    const pair: SymbolPair = {
      base,
      head,
      rationale: "name-signature",
      throughMembers: targets.length,
    }
    matched.push(pair)
    record(pair)
  }
  return { matched, refusals }
}

/** One with a signature has had stage 4's judgement, and a dropped one is stage 4.5's. */
function isCandidate(symbol: IRSymbol): boolean {
  return !symbol.dropped && (symbol.signature ?? null) === null
}

/** An object literal nested under a key has no Symbol, so `api.v1.get` belongs to `api`. */
function enclosingIn(symbols: readonly IRSymbol[]): (symbol: IRSymbol) => IRSymbol | undefined {
  const byId = new Map<string, IRSymbol>(symbols.map((symbol) => [symbol.id, symbol]))
  return (symbol) => {
    const { prefix, qualifiedName } = splitId(symbol)
    for (let owner = ownerOf(qualifiedName); owner !== ""; owner = ownerOf(owner)) {
      const found = byId.get(`${prefix}${owner}`)
      if (found !== undefined) return found
    }
    return undefined
  }
}

/** A path holds no `#`, so the first one ends the prefix. */
function splitId(symbol: IRSymbol): { prefix: string; qualifiedName: string } {
  const end = symbol.id.indexOf("#") + 1
  return { prefix: symbol.id.slice(0, end), qualifiedName: symbol.id.slice(end) }
}

function deepestFirst(symbols: readonly IRSymbol[]): IRSymbol[] {
  return symbols
    .map((symbol) => ({ symbol, depth: depthOf(splitId(symbol).qualifiedName) }))
    .sort((a, b) => b.depth - a.depth || compareCodeUnit(a.symbol.id, b.symbol.id))
    .map(({ symbol }) => symbol)
}

function depthOf(qualifiedName: string): number {
  let depth = 0
  for (let name = qualifiedName; name !== ""; name = ownerOf(name)) depth++
  return depth
}

function appendTo(table: Map<string, string[]>, key: string, value: string): void {
  const values = table.get(key)
  if (values === undefined) table.set(key, [value])
  else values.push(value)
}
