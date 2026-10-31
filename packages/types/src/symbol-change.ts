import type { SymbolChange } from "./generated/diff"
import type { Symbol as IRSymbol } from "./generated/ir"

/**
 * The head's Symbol for a pair. The report files an entry under it and the gate judges the entry
 * by it, so the two agree only while both read it here.
 */
export function representativeSymbol(change: SymbolChange): IRSymbol {
  return "symbol" in change ? change.symbol : change.after
}
