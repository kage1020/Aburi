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

const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

export function unwrapValue(node: Node): Node {
  let cursor: Node = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = firstNonCommentChild(cursor)
    if (inner === null) return cursor
    cursor = inner
  }
  return cursor
}

export function asFunctionValue(node: Node): Node | null {
  const value = unwrapValue(node)
  const isFunction = value.type === "arrow_function" || value.type === "function_expression"
  return isFunction ? value : null
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
