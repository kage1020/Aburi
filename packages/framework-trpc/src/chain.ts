import { calleeName, type SyntaxNode, unwrapValue } from "@aburi/core"
import { COMPUTED_TARGET_SEGMENT } from "@aburi/types"

export interface Chain {
  /** The call the initializer makes, or `null` when it reads a member and calls nothing. */
  readonly call: SyntaxNode | null
  /** `<receiver>.<method>` as `calleeName` names a call, and `<root>.<property>` for a member read. */
  readonly name: string
  readonly leaf: string
  /** The properties read between the root and the leaf, outermost first. */
  readonly path: readonly string[]
  readonly root: string
}

export function readChain(initializer: SyntaxNode): Chain | null {
  if (initializer.type === "call_expression") {
    const callee = calleeName(initializer)
    const fn = initializer.childForFieldName("function")
    if (callee === null || fn === null) return null
    const object = fn.type === "member_expression" ? fn.childForFieldName("object") : null
    const below = object === null ? { path: [], root: callee.name } : receiverOf(object)
    return { call: initializer, name: callee.name, leaf: callee.leaf, ...below }
  }
  if (initializer.type === "member_expression") {
    const object = initializer.childForFieldName("object")
    const leaf = initializer.childForFieldName("property")?.text ?? ""
    if (object === null || leaf.length === 0) return null
    const below = receiverOf(object)
    return { call: null, name: `${below.root}.${leaf}`, leaf, ...below }
  }
  return null
}

export function writtenArguments(call: SyntaxNode): SyntaxNode[] {
  const list = call.childForFieldName("arguments")
  if (list === null || list.type !== "arguments") return []
  return list.namedChildren.filter(
    (child): child is SyntaxNode => child !== null && child.type !== "comment",
  )
}

// The steps and wrappers `calleeName` reads through, so `path` and `root` describe the receiver it names.
function receiverOf(node: SyntaxNode): { path: string[]; root: string } {
  const path: string[] = []
  let cursor = unwrapValue(node)
  for (;;) {
    let next: SyntaxNode | null = null
    if (cursor.type === "call_expression") next = cursor.childForFieldName("function")
    else if (cursor.type === "subscript_expression") next = cursor.childForFieldName("object")
    else if (cursor.type === "member_expression") {
      const property = cursor.childForFieldName("property")?.text ?? ""
      if (property.length > 0) path.push(property)
      next = cursor.childForFieldName("object")
    }
    if (next === null) break
    cursor = unwrapValue(next)
  }
  const named = (cursor.type === "identifier" || cursor.type === "this") && cursor.text.length > 0
  return { path, root: named ? cursor.text : COMPUTED_TARGET_SEGMENT }
}
