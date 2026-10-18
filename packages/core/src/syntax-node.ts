import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"

export interface SyntaxNode {
  readonly type: string
  readonly text: string
  readonly namedChildren: readonly (SyntaxNode | null)[]
  readonly children: readonly (SyntaxNode | null)[]
  childForFieldName(name: string): SyntaxNode | null
}

export function asSyntaxNode(value: unknown): SyntaxNode | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<SyntaxNode>
  if (typeof candidate.type !== "string") return null
  if (typeof candidate.text !== "string") return null
  if (!Array.isArray(candidate.children) || !Array.isArray(candidate.namedChildren)) return null
  if (typeof candidate.childForFieldName !== "function") return null
  return candidate as SyntaxNode
}

export function findNamedChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

export function declaratorValue(statement: SyntaxNode, binding: string): SyntaxNode | null {
  for (const child of statement.namedChildren) {
    if (child === null || child.type !== "variable_declarator") continue
    const declared = child.childForFieldName("name")
    if (declared === null || declared.type !== "identifier" || declared.text !== binding) continue
    const value = child.childForFieldName("value")
    return value === null ? null : unwrapValue(value)
  }
  return null
}

// `<T>x` is left out because lang-typescript does not read through it either.
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

export function unwrapValue(node: SyntaxNode): SyntaxNode {
  let cursor = node
  while (VALUE_WRAPPER_TYPES.has(cursor.type)) {
    const inner = cursor.namedChildren.find((child) => child !== null && child.type !== "comment")
    if (inner === undefined || inner === null) return cursor
    cursor = inner
  }
  return cursor
}

export function findFirstDescendantOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  if (node.type === typeName) return node
  for (const child of node.namedChildren) {
    if (child === null) continue
    const found = findFirstDescendantOfType(child, typeName)
    if (found !== null) return found
  }
  return null
}

export function calleeText(callNode: SyntaxNode): string | null {
  const callee = callNode.childForFieldName("function")
  if (callee === null) return null
  return callee.text.length > 0 ? callee.text : null
}

export function calleeLeaf(callee: string): string {
  const dot = callee.lastIndexOf(".")
  return dot < 0 ? callee : callee.slice(dot + 1)
}

export interface CalleeName {
  /** The name the chain starts from and the name called: `app.get` for `app.route("/x").get`. */
  readonly name: string
  readonly leaf: string
}

export function calleeName(callNode: SyntaxNode): CalleeName | null {
  const callee = callNode.childForFieldName("function")
  if (callee === null) return null
  if (callee.type === "identifier") {
    return callee.text.length > 0 ? { name: callee.text, leaf: callee.text } : null
  }
  if (callee.type !== "member_expression") return null
  const object = callee.childForFieldName("object")
  const leaf = callee.childForFieldName("property")?.text ?? ""
  if (object === null || leaf.length === 0) return null
  return { name: `${chainRoot(object)}.${leaf}`, leaf }
}

const NAMED_ROOT_TYPES: ReadonlySet<string> = new Set(["identifier", "this", "super"])

function chainRoot(node: SyntaxNode): string {
  let cursor = unwrapValue(node)
  let next = chainStep(cursor)
  while (next !== null) {
    cursor = unwrapValue(next)
    next = chainStep(cursor)
  }
  // Any other root's text would carry its line breaks and comments into the name.
  return NAMED_ROOT_TYPES.has(cursor.type) && cursor.text.length > 0
    ? cursor.text
    : COMPUTED_TARGET_SEGMENT
}

function chainStep(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "call_expression") return node.childForFieldName("function")
  if (node.type === "member_expression" || node.type === "subscript_expression") {
    return node.childForFieldName("object")
  }
  return null
}

export function anyCallCalleeMatches(
  node: SyntaxNode,
  predicate: (leaf: string) => boolean,
): boolean {
  if (node.type === "call_expression") {
    const callee = calleeText(node)
    if (callee !== null && predicate(calleeLeaf(callee))) return true
  }
  for (const child of node.namedChildren) {
    if (child !== null && anyCallCalleeMatches(child, predicate)) return true
  }
  return false
}
