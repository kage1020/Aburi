import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"
import { DEFAULT_EXPORT_QNAME } from "./id"

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

/** A node's named children as written, comments left out. */
export function writtenChildren(node: SyntaxNode | null): SyntaxNode[] {
  if (node === null) return []
  return node.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}

export function findNamedChildOfType(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
  }
  return null
}

export function declaratorValue(statement: SyntaxNode, name: string): SyntaxNode | null {
  if (statement.type === "export_statement") {
    const value = name === DEFAULT_EXPORT_QNAME ? statement.childForFieldName("value") : null
    return value === null ? null : unwrapValue(value)
  }
  for (const child of statement.namedChildren) {
    if (child === null || child.type !== "variable_declarator") continue
    const declared = child.childForFieldName("name")
    if (declared === null || declared.type !== "identifier" || declared.text !== name) continue
    const value = child.childForFieldName("value")
    return value === null ? null : unwrapValue(value)
  }
  return null
}

// lang-typescript names Symbols through this reader too, so a framework's role and the Symbol's name
// read the same initializer. `<T>x` is left out because Symbol naming does not read through it.
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
])

export function unwrapValue<
  N extends { readonly type: string; readonly namedChildren: readonly (N | null)[] },
>(node: N): N {
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
  return { name: `${rootName(walkReceiverChain(object).root)}.${leaf}`, leaf }
}

export interface ReceiverChain {
  /** Each property read and method called on the way down to the root, outermost first. */
  readonly path: readonly string[]
  /** The name the chain starts from, as `calleeName` names it. */
  readonly root: string
}

/** The receiver `calleeName` names, read step for step as it reads it. */
export function receiverChain(node: SyntaxNode): ReceiverChain {
  const { steps, root } = walkReceiverChain(node)
  const path = steps.flatMap((step) => {
    if (step.type !== "member_expression") return []
    const property = step.childForFieldName("property")?.text ?? ""
    return property.length > 0 ? [property] : []
  })
  return { path, root: rootName(root) }
}

interface ChainNode<N> {
  readonly type: string
  readonly namedChildren: readonly (N | null)[]
  childForFieldName(name: string): N | null
}

export interface ReceiverChainWalk<N> {
  /** Each call, member access and index passed on the way down to the root, outermost first. */
  readonly steps: readonly N[]
  /** The node the chain starts from. */
  readonly root: N
}

/**
 * The one walk down a receiver chain, through `unwrapValue`'s wrappers. Every reader of a chain
 * takes it from here, so a framework's name for a call and the language plugin's cannot drift.
 */
export function walkReceiverChain<N extends ChainNode<N>>(node: N): ReceiverChainWalk<N> {
  const steps: N[] = []
  let cursor = unwrapValue(node)
  for (let next = chainStep(cursor); next !== null; next = chainStep(cursor)) {
    steps.push(cursor)
    cursor = unwrapValue(next)
  }
  return { steps, root: cursor }
}

/** The calls a chain passes before its first index, outermost first, where it starts included. */
export function chainCalls<N extends ChainNode<N>>(node: N): N[] {
  const { steps, root } = walkReceiverChain(node)
  const calls: N[] = []
  for (const step of [...steps, root]) {
    if (step.type === "subscript_expression") break
    if (step.type === "call_expression") calls.push(step)
  }
  return calls
}

const NAMED_ROOT_TYPES: ReadonlySet<string> = new Set(["identifier", "this"])

// Any other root's text would carry its line breaks and comments into the name.
function rootName(root: SyntaxNode): string {
  return NAMED_ROOT_TYPES.has(root.type) && root.text.length > 0
    ? root.text
    : COMPUTED_TARGET_SEGMENT
}

function chainStep<N extends ChainNode<N>>(node: N): N | null {
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
    const callee = calleeName(node)
    if (callee !== null && predicate(callee.leaf)) return true
  }
  for (const child of node.namedChildren) {
    if (child !== null && anyCallCalleeMatches(child, predicate)) return true
  }
  return false
}
