import {
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  findNamedChildOfType,
  type SyntaxNode,
} from "@aburi/core"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export interface RouterCall {
  /** Full callee text as written in source: "Router" or "express.Router". */
  readonly callee: string
}

/**
 * The declarator's `value` must BE the `Router()` / `express.Router()` call (parentheses
 * transparent); `[Router()]` or `withLogging(Router())` is rejected so `high` confidence
 * never goes to a merely adjacent Router mention.
 */
export function extractRouterCall(fullNode: unknown): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  const declarator = findNamedChildOfType(node, "variable_declarator")
  if (declarator === null) return null
  const initializer = unwrapParens(declarator.childForFieldName("value"))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeText(initializer)
  if (callee === null) return null
  if (!EXPRESS_ROUTER_FACTORIES.has(calleeLeaf(callee))) return null
  return { callee }
}

function unwrapParens(node: SyntaxNode | null): SyntaxNode | null {
  let cursor = node
  while (cursor !== null && cursor.type === "parenthesized_expression") {
    const inner = cursor.namedChildren[0]
    cursor = inner ?? null
  }
  return cursor
}
