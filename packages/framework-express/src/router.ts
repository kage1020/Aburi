import { asSyntaxNode, calleeLeaf, calleeText, type SyntaxNode } from "./ast"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export interface RouterCall {
  /** Full callee text as written in source: "Router" or "express.Router". */
  readonly callee: string
}

/**
 * Only accept a variable declaration whose declarator's `value` field IS the
 * `Router()` / `express.Router()` call itself — parentheses transparent. Anything
 * else (`[Router()]`, `withLogging(Router())`, `Router() ? a : b`) is rejected so
 * `high` confidence is never awarded to a merely-adjacent Router mention.
 */
export function extractRouterCall(fullNode: unknown): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  const declarator = findDirectChild(node, "variable_declarator")
  if (declarator === null) return null
  const initializer = unwrapParens(declarator.childForFieldName("value"))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeText(initializer)
  if (callee === null) return null
  if (!EXPRESS_ROUTER_FACTORIES.has(calleeLeaf(callee))) return null
  return { callee }
}

function findDirectChild(node: SyntaxNode, typeName: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child !== null && child.type === typeName) return child
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
