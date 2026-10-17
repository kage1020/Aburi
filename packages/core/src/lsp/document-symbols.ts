import type { Symbol as IRSymbol, SymbolId } from "@aburi/types"
import type {
  DocumentSymbol,
  Position,
  Range,
  SymbolInformation,
} from "vscode-languageserver-protocol"
import { lastQnameSegment } from "../fingerprint/short-name"
import { DEFAULT_EXPORT_QNAME } from "../id"
import { DEFAULT_EXPORT_NAME } from "../import-edge"

interface NamedRange {
  name: string
  range: Range
  nameStart: Position
}

// A word right after `@` or `.` names the decorator itself, as in `@readonly m()`.
const TRAILING_MODIFIER =
  /(?:(?<![\p{ID_Continue}$@.#])(?:export|default|declare|abstract|class|static|public|private|protected|readonly|override|accessor|async|get|set)|\*)[ \t]*$/u

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
    // tsserver starts a decorated declaration's range at its first decorator; the IR starts there
    // too, or below them where the decorators sit outside the node, never below the name's line.
    const match =
      named.find(
        (entry) =>
          entry.range.start.line + 1 === line && entry.name === lastQnameSegment(symbol.name),
      ) ??
      named.find(
        (entry) =>
          entry.range.start.line + 1 < line &&
          line <= entry.nameStart.line + 1 &&
          entry.name === lastQnameSegment(symbol.name),
      )
    const working = workingById.get(symbol.id)
    if (match === undefined || working === undefined) continue
    lines ??= content.split(/\r\n|\r|\n/)
    const startColumn = declarationStartColumn(match, line, lines)
    if (startColumn === null) continue
    working.source = {
      ...working.source,
      startColumn,
      endColumn: match.range.end.character + 1,
    }
  }
}

// The server gives no column for where a declaration starts after its decorators. Where the IR's
// line is the first decorator's own, the decorators are inside the node and the range is right.
function declarationStartColumn(
  entry: NamedRange,
  line: number,
  lines: readonly string[],
): number | null {
  const { start } = entry.range
  const startsOnLine = start.line + 1 === line
  if (startsOnLine && lines[start.line]?.[start.character] !== "@") return start.character + 1
  const declaration = walkBackOverModifiers(entry.nameStart, start, lines)
  if (declaration.line + 1 === line) return declaration.character + 1
  return startsOnLine ? start.character + 1 : null
}

function walkBackOverModifiers(
  name: Position,
  limit: Position,
  lines: readonly string[],
): Position {
  let found = name
  let line = name.line
  let end = name.character
  for (;;) {
    const before = (lines[line] ?? "").slice(0, end)
    const modifier = TRAILING_MODIFIER.exec(before)
    if (modifier !== null && (line > limit.line || modifier.index >= limit.character)) {
      found = { line, character: modifier.index }
      end = modifier.index
      continue
    }
    if (before.trim() !== "" || line <= limit.line) return found
    line -= 1
    end = (lines[line] ?? "").length
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
    nameStart: (nameRange ?? range).start,
  }
}
