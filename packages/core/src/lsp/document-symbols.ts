import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import type { DocumentSymbol, Range, SymbolInformation } from "vscode-languageserver-protocol"
import { lastQnameSegment } from "../fingerprint/short-name"

export function applyDocumentSymbols(
  entries: DocumentSymbol[] | SymbolInformation[],
  fileSymbols: readonly IRSymbol[],
  workingById: Map<SymbolId, IRSymbol>,
): void {
  const named = namedRangesInPreOrder(entries)
  for (const symbol of fileSymbols) {
    const match = named.find(
      (entry) =>
        entry.range.start.line + 1 === symbol.source.startLine &&
        entry.name === lastQnameSegment(symbol.name),
    )
    const working = workingById.get(symbol.id)
    if (match === undefined || working === undefined) continue
    working.source = {
      ...working.source,
      startColumn: match.range.start.character + 1,
      endColumn: match.range.end.character + 1,
    }
  }
}

/** A stack rather than recursion: the server chooses the tree's depth. */
function namedRangesInPreOrder(
  entries: DocumentSymbol[] | SymbolInformation[],
): Array<{ name: string; range: Range }> {
  const named: Array<{ name: string; range: Range }> = []
  const stack: (DocumentSymbol | SymbolInformation)[] = [...entries].reverse()
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    if (!("range" in entry)) {
      if (entry.location?.range !== undefined)
        named.push({ name: entry.name, range: entry.location.range })
      continue
    }
    named.push({ name: entry.name, range: entry.range })
    const children = entry.children
    if (!Array.isArray(children)) continue
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return named
}
