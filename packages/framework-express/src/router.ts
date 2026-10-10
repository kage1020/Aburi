import {
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  lastQnameSegment,
  type SyntaxNode,
} from "@aburi/core"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export interface RouterCall {
  readonly callee: string
}

export function extractRouterCall(fullNode: unknown, name: string): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const declarator = declaratorOf(node, lastQnameSegment(name))
  if (declarator === null) return null
  const initializer = unwrapParens(declarator.childForFieldName("value"))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeText(initializer)
  if (callee === null) return null
  if (!EXPRESS_ROUTER_FACTORIES.has(calleeLeaf(callee))) return null
  return { callee }
}

function declaratorOf(statement: SyntaxNode, binding: string): SyntaxNode | null {
  for (const child of statement.namedChildren) {
    if (child === null || child.type !== "variable_declarator") continue
    const declared = child.childForFieldName("name")
    if (declared !== null && declared.type === "identifier" && declared.text === binding) {
      return child
    }
  }
  return null
}

function unwrapParens(node: SyntaxNode | null): SyntaxNode | null {
  let cursor = node
  while (cursor !== null && cursor.type === "parenthesized_expression") {
    const inner = cursor.namedChildren[0]
    cursor = inner ?? null
  }
  return cursor
}
