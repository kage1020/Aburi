import { DEFAULT_EXPORT_NAME } from "@aburi/core"
import type { SymbolCandidate, Visibility } from "@aburi/types"
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

const EXPORT_DEFAULT = "export-default"

const EXPORT_KEYWORD = "export-keyword"

const EXPORT_CLAUSE = "export-clause"

export function exportEvidence(node: Node): string[] {
  if (isDefaultExport(node)) return [EXPORT_DEFAULT]
  return hasExportModifier(node) ? [EXPORT_KEYWORD] : []
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
    const tokens = candidate.kind === "call" ? undefined : exported.get(candidate.name)
    const added = tokens?.filter((token) => !candidate.derivedBy.includes(token)) ?? []
    if (added.length === 0) return candidate
    return { ...candidate, visibility: "public", derivedBy: [...candidate.derivedBy, ...added] }
  })
}

function detachedExportsByLocalName(root: Node): ReadonlyMap<string, readonly string[]> {
  const exported = new Map<string, string[]>()
  const record = (local: string, as: string): void => {
    const token = as === DEFAULT_EXPORT_NAME ? EXPORT_DEFAULT : `${EXPORT_CLAUSE}:${as}`
    const tokens = exported.get(local)
    if (tokens === undefined) exported.set(local, [token])
    else if (!tokens.includes(token)) tokens.push(token)
  }
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    // A re-export binds nothing here, so a declaration sharing one of its names is not what it exports.
    if (stmt.childForFieldName("source") !== null) continue
    const clause = findChild(stmt, "export_clause")
    if (clause !== null) {
      for (const specifier of clause.namedChildren) {
        if (specifier === null || specifier.type !== "export_specifier") continue
        const local = specifier.childForFieldName("name")
        if (local === null || local.type !== "identifier") continue
        const alias = specifier.childForFieldName("alias")
        const as = alias === null ? local.text : moduleExportName(alias)
        if (as !== null) record(local.text, as)
      }
      continue
    }
    if (!hasChildOfType(stmt, "default")) continue
    const value = stmt.childForFieldName("value")
    if (value === null) continue
    const inner = unwrapValue(value)
    if (inner.type === "identifier") record(inner.text, DEFAULT_EXPORT_NAME)
  }
  return exported
}

function moduleExportName(node: Node): string | null {
  return node.type === "identifier" ? node.text : readStaticString(node)
}
