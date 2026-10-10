import { asSyntaxNode, calleeLeaf, calleeText, findFirstDescendantOfType } from "@aburi/core"

/** Bare identifiers only: `React.<name>` callees are matched by leaf. */
export const REACT_CONTEXT_FACTORIES: ReadonlySet<string> = new Set(["createContext"])
export const REACT_FORWARD_REF_FACTORIES: ReadonlySet<string> = new Set(["forwardRef"])
export const REACT_MEMO_FACTORIES: ReadonlySet<string> = new Set(["memo"])

export interface WrapperCall {
  readonly callee: string
  readonly leaf: string
}

export function extractWrapperCall(fullNode: unknown): WrapperCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  const call = findFirstDescendantOfType(node, "call_expression")
  if (call === null) return null
  const callee = calleeText(call)
  if (callee === null) return null
  return { callee, leaf: calleeLeaf(callee) }
}

export function isContextCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_CONTEXT_FACTORIES.has(call.leaf)
}

export function isForwardRefCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_FORWARD_REF_FACTORIES.has(call.leaf)
}

export function isMemoCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_MEMO_FACTORIES.has(call.leaf)
}
