import {
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  EXPORT_DEFAULT_DERIVED_BY,
  EXPORT_KEYWORD_DERIVED_BY,
} from "@aburi/types"
import { DEFAULT_EXPORT_NAME } from "./import-edge"

export interface ExportEvidence {
  readonly name: string
  readonly derivedBy: readonly string[]
}

// `export-keyword` gives the whole qname: a namespace member is exported from its namespace, not the
// module, so `N.GET` neither reads as the module's `GET` nor stops being the Symbol's own name for the
// api fingerprint.
export function exportNames(symbol: ExportEvidence): string[] {
  const names = new Set<string>()
  for (const token of symbol.derivedBy) {
    if (token === EXPORT_KEYWORD_DERIVED_BY) names.add(symbol.name)
    else if (token === EXPORT_DEFAULT_DERIVED_BY) names.add(DEFAULT_EXPORT_NAME)
    else if (token.startsWith(EXPORT_CLAUSE_DERIVED_BY_PREFIX)) {
      names.add(token.slice(EXPORT_CLAUSE_DERIVED_BY_PREFIX.length))
    }
  }
  return [...names]
}
