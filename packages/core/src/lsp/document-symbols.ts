import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import type { DocumentSymbol, Range, SymbolInformation } from "vscode-languageserver-protocol"
import { lastQnameSegment } from "../fingerprint/short-name"
import { DEFAULT_EXPORT_QNAME } from "../id"
import { DEFAULT_EXPORT_NAME } from "../import-edge"

interface NamedRange {
  name: string
  range: Range
  nameLine: number
}

export function applyDocumentSymbols(
  entries: DocumentSymbol[] | SymbolInformation[],
  content: string,
  fileSymbols: readonly IRSymbol[],
  workingById: Map<SymbolId, IRSymbol>,
): void {
  const named = namedRangesInPreOrder(entries)
  let lines: string[] | null = null
  for (const symbol of fileSymbols) {
    const line = symbol.source.startLine
    // tsserver starts a decorated declaration's range at its first decorator, while the IR starts
    // it after them, on or above the line its name is on.
    const match = named.find(
      (entry) =>
        entry.range.start.line + 1 <= line &&
        line <= entry.nameLine &&
        entry.name === lastQnameSegment(symbol.name),
    )
    const working = workingById.get(symbol.id)
    if (match === undefined || working === undefined) continue
    let startColumn = match.range.start.character + 1
    if (match.range.start.line + 1 !== line) {
      // The server gives no column for where the declaration starts below its decorators.
      lines ??= content.split(/\r\n|\r|\n/)
      startColumn = firstNonBlankColumn(lines[line - 1] ?? "")
    }
    working.source = {
      ...working.source,
      startColumn,
      endColumn: match.range.end.character + 1,
    }
  }
}

/** A stack rather than recursion: the server chooses the tree's depth. */
function namedRangesInPreOrder(entries: DocumentSymbol[] | SymbolInformation[]): NamedRange[] {
  const named: NamedRange[] = []
  const stack = [...entries].reverse().map((entry) => ({ entry, topLevel: true }))
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { entry, topLevel } = item
    if (!("range" in entry)) {
      if (entry.location?.range !== undefined) {
        const atTop = (entry.containerName ?? "") === ""
        named.push(namedRange(entry.name, atTop, entry.location.range))
      }
      continue
    }
    named.push(namedRange(entry.name, topLevel, entry.range, entry.selectionRange))
    const children = entry.children
    if (!Array.isArray(children)) continue
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child !== undefined) stack.push({ entry: child, topLevel: false })
    }
  }
  return named
}

// Only at the top is `default` the anonymous default export; a class member may be named `default`.
function namedRange(name: string, topLevel: boolean, range: Range, nameRange?: Range): NamedRange {
  return {
    name: topLevel && name === DEFAULT_EXPORT_NAME ? DEFAULT_EXPORT_QNAME : name,
    range,
    nameLine: (nameRange ?? range).start.line + 1,
  }
}

function firstNonBlankColumn(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0].length ?? 0) + 1
}
