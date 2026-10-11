import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import { groupBy } from "./collections"

type Language = string
type FilePath = string
type ComponentKey = string
type ByName = ReadonlyMap<string, readonly IRSymbol[]>

export interface SymbolTable {
  keptSymbolIds: ReadonlySet<SymbolId>
  topLevelByFile: ReadonlyMap<FilePath, ByName>
  filesByLanguage: ReadonlyMap<Language, ReadonlySet<FilePath>>
  byComponent: ReadonlyMap<Language, ReadonlyMap<ComponentKey, ByName>>
  byWorkspace: ReadonlyMap<Language, ByName>
}

export function buildSymbolTable(symbols: readonly IRSymbol[]): SymbolTable {
  const kept = symbols.filter((symbol) => !symbol.dropped)
  const byName = (group: readonly IRSymbol[]) => groupBy(group, (symbol) => symbol.name)
  const keptByLanguage = groupBy(kept, (symbol) => symbol.language)
  return {
    keptSymbolIds: new Set(kept.map((symbol) => symbol.id)),
    topLevelByFile: mapValues(
      groupBy(
        kept.filter((symbol) => !symbol.name.includes(".")),
        (symbol) => symbol.source.file,
      ),
      byName,
    ),
    filesByLanguage: mapValues(
      groupBy(symbols, (symbol) => symbol.language),
      (perLanguage) => new Set(perLanguage.map((symbol) => symbol.source.file)),
    ),
    byComponent: mapValues(keptByLanguage, (perLanguage) =>
      mapValues(
        groupBy(perLanguage, (symbol) => componentKeyOf(symbol.component)),
        byName,
      ),
    ),
    byWorkspace: mapValues(keptByLanguage, byName),
  }
}

export function componentKeyOf(component: string | null | undefined): ComponentKey {
  return component ?? ""
}

function mapValues<K, V, W>(map: ReadonlyMap<K, V>, transform: (value: V) => W): Map<K, W> {
  return new Map([...map].map(([key, value]) => [key, transform(value)]))
}
