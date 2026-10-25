import type { IR, Symbol as IRSymbol } from "@aburi/types"

/** The Symbol with exactly this id, or a failure that lists what the scan produced. */
export function symbolById(result: { readonly ir: IR }, id: string): IRSymbol {
  const found = result.ir.symbols.find((symbol) => symbol.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${result.ir.symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

/**
 * `symbol.derivedBy` from its first entry that starts with `prefix` on: the scan writes a framework
 * plugin's entries after the language plugin's, and one it split on `;` loses the prefix.
 */
export function frameworkEntries(symbol: IRSymbol, prefix: string): string[] {
  const own = symbol.derivedBy.findIndex((entry) => entry.startsWith(prefix))
  return own < 0 ? [] : symbol.derivedBy.slice(own)
}

/** The Symbol with exactly this qualified name, or a failure that lists what the scan produced. */
export function symbolNamed(result: { readonly ir: IR }, name: string): IRSymbol {
  const found = result.ir.symbols.find((symbol) => symbol.name === name)
  if (found === undefined) {
    throw new Error(
      `no Symbol named "${name}"; have ${result.ir.symbols.map((s) => s.name).join(", ")}`,
    )
  }
  return found
}
