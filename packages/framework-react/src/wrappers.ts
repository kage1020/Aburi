import { asSyntaxNode, calleeLeaf, calleeText, findFirstDescendantOfType } from "@aburi/core"

/** Bare identifiers only: `React.<name>` callees are matched by leaf. */
export const REACT_CONTEXT_FACTORIES: ReadonlySet<string> = new Set(["createContext"])
export const REACT_FORWARD_REF_FACTORIES: ReadonlySet<string> = new Set(["forwardRef"])
export const REACT_MEMO_FACTORIES: ReadonlySet<string> = new Set(["memo"])

export interface WrapperCall {
  /** Callee text verbatim, e.g. `"createContext"` or `"React.forwardRef"`. */
  readonly callee: string
  /** Callee leaf (e.g. `"forwardRef"` from `"React.forwardRef"`). */
  readonly leaf: string
}

/**
 * The outermost `call_expression` under a `const X = <call>(...)` node, or `null` when there
 * is none. Pre-order finds the wrapping `forwardRef(...)` before any inner render-body call.
 */
export function extractWrapperCall(fullNode: unknown): WrapperCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  const call = findFirstDescendantOfType(node, "call_expression")
  if (call === null) return null
  const callee = calleeText(call)
  if (callee === null) return null
  return { callee, leaf: calleeLeaf(callee) }
}

/** `true` when `call` is `createContext(...)` or `React.createContext(...)`. */
export function isContextCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_CONTEXT_FACTORIES.has(call.leaf)
}

/** `true` when `call` is `forwardRef(...)` or `React.forwardRef(...)`. */
export function isForwardRefCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_FORWARD_REF_FACTORIES.has(call.leaf)
}

/** `true` when `call` is `memo(...)` or `React.memo(...)`. */
export function isMemoCall(call: WrapperCall | null): boolean {
  return call !== null && REACT_MEMO_FACTORIES.has(call.leaf)
}
