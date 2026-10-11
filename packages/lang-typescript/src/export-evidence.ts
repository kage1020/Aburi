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

const EXPORT_DEFAULT = "export-default"

const EXPORT_KEYWORD = "export-keyword"

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

export function promoteDefaultExports(
  root: Node,
  candidates: SymbolCandidate<Node>[],
): SymbolCandidate<Node>[] {
  const names = defaultExportedNames(root)
  if (names.size === 0) return candidates
  return candidates.map((candidate): SymbolCandidate<Node> => {
    if (candidate.kind === "call" || !names.has(candidate.name)) return candidate
    if (candidate.derivedBy.includes(EXPORT_DEFAULT)) return candidate
    return {
      ...candidate,
      visibility: "public",
      derivedBy: [...candidate.derivedBy, EXPORT_DEFAULT],
    }
  })
}

function defaultExportedNames(root: Node): ReadonlySet<string> {
  const names = new Set<string>()
  for (const stmt of root.namedChildren) {
    if (stmt === null || stmt.type !== "export_statement") continue
    if (!hasChildOfType(stmt, "default")) continue
    const value = stmt.childForFieldName("value")
    if (value === null) continue
    const inner = unwrapValue(value)
    if (inner.type !== "identifier") continue
    names.add(inner.text)
  }
  return names
}
