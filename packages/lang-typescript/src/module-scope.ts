import { MODULE_SCOPE_QNAME } from "@aburi/core"
import type { ExtractionContext, SymbolCandidate } from "@aburi/types"
import type { Node } from "web-tree-sitter"
import { hasErrorChild, makeSourceRange } from "./ast-helpers"
import { makeTsSymbolId } from "./qname"

const MODULE_SCOPE_DERIVED_BY = "module-scope"

const CONTROL_STATEMENTS: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "try_statement",
  "switch_statement",
  "labeled_statement",
  "statement_block",
  "throw_statement",
  "with_statement",
])

export function isControlStatement(node: Node): boolean {
  return CONTROL_STATEMENTS.has(node.type)
}

export function runsCode(statement: Node): boolean {
  // A statement the parser recovered is what is left of something else, often a declaration.
  if (hasErrorChild(statement)) return false
  return !isDirective(statement)
}

// A lone string is a directive (`"use client"`) or evaluates to nothing; either way it runs no code.
function isDirective(statement: Node): boolean {
  const parts = statement.namedChildren.filter(
    (child): child is Node => child !== null && child.type !== "comment",
  )
  return parts.length === 1 && parts[0]?.type === "string"
}

export function makeModuleScopeCandidate(
  statements: readonly Node[],
  ctx: ExtractionContext,
): SymbolCandidate<Node> | null {
  const [first, ...rest] = statements
  const last = rest.at(-1) ?? first
  if (first === undefined || last === undefined) return null
  return {
    id: makeTsSymbolId(ctx.file.path, MODULE_SCOPE_QNAME),
    kind: "module",
    extKind: null,
    name: MODULE_SCOPE_QNAME,
    visibility: "internal",
    decorators: [],
    signature: null,
    source: { ...makeSourceRange(first, ctx), endLine: last.endPosition.row + 1 },
    derivedBy: [MODULE_SCOPE_DERIVED_BY],
    bodyNode: first,
    fullNode: first,
    ...(rest.length > 0
      ? {
          mergedDeclarations: rest.map((statement) => ({
            bodyNode: statement,
            fullNode: statement,
          })),
        }
      : {}),
  }
}
