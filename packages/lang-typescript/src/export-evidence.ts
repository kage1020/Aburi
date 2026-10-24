import { DEFAULT_EXPORT_NAME } from "@aburi/core"
import {
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  EXPORT_DEFAULT_DERIVED_BY,
  EXPORT_KEYWORD_DERIVED_BY,
  type SymbolCandidate,
  type SymbolKind,
  type Visibility,
} from "@aburi/types"
import type { Node } from "web-tree-sitter"
import {
  findChild,
  hasChildOfType,
  hasExportModifier,
  statementParent,
  unwrapValue,
} from "./ast-helpers"
import { hasPrivateName } from "./class-members"
import { readStaticString } from "./string-escape"

export function exportEvidence(node: Node): string[] {
  if (isDefaultExport(node)) return [EXPORT_DEFAULT_DERIVED_BY]
  return hasExportModifier(node) ? [EXPORT_KEYWORD_DERIVED_BY] : []
}

export function topLevelVisibility(node: Node): Visibility {
  return exportEvidence(node).length > 0 ? "public" : "internal"
}

export function memberVisibility(member: Node): Visibility {
  return hasPrivateName(member) ? "private" : accessibilityOf(member)
}

function accessibilityOf(node: Node): Visibility {
  const modifier = findChild(node, "accessibility_modifier")
  if (modifier === null) return "public"
  switch (modifier.text) {
    case "private":
      return "private"
    case "protected":
      return "protected"
    default:
      return "public"
  }
}

/** The `default` an `export_statement` is written with is an anonymous token, hence the child scan. */
export function isDefaultExport(node: Node): boolean {
  const parent = statementParent(node)
  if (parent === null || parent.type !== "export_statement") return false
  return hasChildOfType(parent, "default")
}

export function promoteDetachedExports(
  root: Node,
  candidates: SymbolCandidate<Node>[],
): SymbolCandidate<Node>[] {
  const exported = detachedExportsByLocalName(root)
  if (exported.size === 0) return candidates
  return candidates.map((candidate): SymbolCandidate<Node> => {
    if (candidate.kind === "call") return candidate
    const added = (exported.get(candidate.name) ?? [])
      .filter((name) => !name.typeOnly || TYPE_ONLY_KINDS.has(candidate.kind))
      .map((name) => name.token)
      .filter((token) => !candidate.derivedBy.includes(token))
    if (added.length === 0) return candidate
    return { ...candidate, visibility: "public", derivedBy: [...candidate.derivedBy, ...added] }
  })
}

// A type-only export is erased: it exports a declaration that is only a type, and no value.
const TYPE_ONLY_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["interface", "type"])

interface ExportedName {
  readonly token: string
  readonly typeOnly: boolean
}

function detachedExportsByLocalName(root: Node): ReadonlyMap<string, readonly ExportedName[]> {
  const exported = new Map<string, ExportedName[]>()
  const record = (local: string, as: string, typeOnly: boolean): void => {
    const token =
      as === DEFAULT_EXPORT_NAME
        ? EXPORT_DEFAULT_DERIVED_BY
        : `${EXPORT_CLAUSE_DERIVED_BY_PREFIX}${as}`
    let names = exported.get(local)
    if (names === undefined) {
      names = []
      exported.set(local, names)
    }
    const index = names.findIndex((name) => name.token === token)
    if (index < 0) names.push({ token, typeOnly })
    else if (!typeOnly) names[index] = { token, typeOnly }
  }
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    // A re-export binds nothing here, so a declaration sharing one of its names is not what it exports.
    if (stmt.childForFieldName("source") !== null) continue
    const clause = findChild(stmt, "export_clause")
    if (clause !== null) {
      const typeOnlyClause = hasChildOfType(stmt, "type")
      for (const specifier of clause.namedChildren) {
        if (specifier === null || specifier.type !== "export_specifier") continue
        const local = specifier.childForFieldName("name")
        if (local === null || local.type !== "identifier") continue
        const as = moduleExportName(specifier.childForFieldName("alias") ?? local)
        const typeOnly = typeOnlyClause || hasChildOfType(specifier, "type")
        if (as !== null) record(local.text, as, typeOnly)
      }
      continue
    }
    if (!hasChildOfType(stmt, "default")) continue
    const value = stmt.childForFieldName("value")
    if (value === null) continue
    const inner = unwrapValue(value)
    if (inner.type === "identifier") record(inner.text, DEFAULT_EXPORT_NAME, false)
  }
  return exported
}

function moduleExportName(node: Node): string | null {
  return node.type === "identifier" ? node.text : readStaticString(node)
}
