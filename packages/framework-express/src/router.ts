import {
  asSyntaxNode,
  type CalleeName,
  calleeName,
  declaratorValue,
  lastQnameSegment,
} from "@aburi/core"

export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export type RouterCall = CalleeName

export function extractRouterCall(fullNode: unknown, name: string): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const initializer = declaratorValue(node, lastQnameSegment(name))
  if (initializer === null || initializer.type !== "call_expression") return null
  const callee = calleeName(initializer)
  return callee !== null && EXPRESS_ROUTER_FACTORIES.has(callee.leaf) ? callee : null
}
