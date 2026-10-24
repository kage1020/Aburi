import {
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  declaratorValue,
  lastQnameSegment,
} from "@aburi/core"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export interface RouterCall {
  readonly callee: string
}

export function extractRouterCall(fullNode: unknown, name: string): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const initializer = declaratorValue(node, lastQnameSegment(name))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeText(initializer)
  if (callee === null) return null
  if (!EXPRESS_ROUTER_FACTORIES.has(calleeLeaf(callee))) return null
  return { callee }
}
