import { unwrapValue } from "@aburi/core"
import type { ExtractionContext, SymbolCandidate, WrittenSourceRange } from "@aburi/types"
import type { Node } from "web-tree-sitter"

export function bodyNodesOf(symbol: SymbolCandidate<Node>): Node[] {
  const out: Node[] = symbol.bodyNode === null ? [] : [symbol.bodyNode]
  for (const declaration of symbol.mergedDeclarations ?? []) {
    if (declaration.bodyNode !== null) out.push(declaration.bodyNode)
  }
  return out
}

export function makeSourceRange(node: Node, ctx: ExtractionContext): WrittenSourceRange {
  return {
    file: ctx.file.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: null,
    endColumn: null,
  }
}

export function functionValueOf(node: Node): Node | null {
  const value = node.childForFieldName("value")
  return value === null ? null : asFunctionValue(value)
}

const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
])

export function asFunctionValue(node: Node): Node | null {
  const value = unwrapValue(node)
  return FUNCTION_VALUE_TYPES.has(value.type) ? value : null
}

export function hasErrorChild(node: Node): boolean {
  return node.children.some(
    (child) => child !== null && (child.type === "ERROR" || child.isMissing),
  )
}

export function hasChildOfType(node: Node, typeName: string): boolean {
  for (const child of node.children) {
    if (child !== null && child.type === typeName) return true
  }
  return false
}

export function findChild(node: Node, typeName: string): Node | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

export function throughParentheses(node: Node): Node {
  let cursor = node
  while (cursor.type === "parenthesized_expression" && !hasErrorChild(cursor)) {
    const [only, ...rest] = cursor.namedChildren.filter(
      (child): child is Node => child !== null && child.type !== "comment",
    )
    if (only === undefined || rest.length > 0 || hasErrorChild(only)) return cursor
    cursor = only
  }
  return cursor
}

// A formatter writes `|` before a union's first member when it breaks the union over lines and
// drops it when it joins it, and the parser gives the leading form a level of its own.
export function leadingOperatorOperand(node: Node): Node | null {
  const operator = LEADING_OPERATORS.get(node.type)
  if (operator === undefined) return null
  const [first, operand] = node.children.filter((child) => !child.isExtra)
  if (first?.type !== operator || operand === undefined || operand.isMissing) return null
  return operand
}

const LEADING_OPERATORS: ReadonlyMap<string, string> = new Map([
  ["union_type", "|"],
  ["intersection_type", "&"],
])

export function firstNonCommentChild(node: Node): Node | null {
  for (const child of node.namedChildren) {
    if (child === null || child.type === "comment") continue
    return child
  }
  return null
}

export interface WalkOptions {
  anonymous?: boolean
  descend?: (node: Node) => boolean
}

export function* walkDescendants(root: Node, options: WalkOptions = {}): Iterable<Node> {
  const anonymous = options.anonymous === true
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    yield node
    if (options.descend !== undefined && !options.descend(node)) continue
    const count = anonymous ? node.childCount : node.namedChildCount
    for (let i = count - 1; i >= 0; i--) {
      const child = anonymous ? node.child(i) : node.namedChild(i)
      if (child !== null) stack.push(child)
    }
  }
}

export interface ThrownValue {
  node: Node
  viaNew: boolean
}

export function thrownValue(throwNode: Node): ThrownValue | null {
  const argument = throwNode.namedChild(0)
  if (argument === null) return null
  if (argument.type === "new_expression") {
    const ctor = argument.childForFieldName("constructor")
    if (ctor !== null) return { node: ctor, viaNew: true }
  }
  return { node: argument, viaNew: false }
}

export const AMBIENT_DECLARATION_TYPE = "ambient_declaration"

export function inAmbientContext(node: Node): boolean {
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (cursor.type === AMBIENT_DECLARATION_TYPE) return true
    if (cursor.type === "program") return false
  }
  return false
}

export function nameFieldText(node: Node): string | null {
  const name = node.childForFieldName("name")
  if (name === null) return null
  const text = name.text
  return text.length > 0 ? text : null
}

export function statementParent(node: Node): Node | null {
  const parent = node.parent
  if (parent !== null && parent.type === AMBIENT_DECLARATION_TYPE) return parent.parent
  return parent
}

export function hasExportModifier(node: Node): boolean {
  const parent = statementParent(node)
  return parent !== null && parent.type === "export_statement"
}
