import { asSyntaxNode, calleeLeaf, calleeText, findFirstDescendantOfType } from "./ast"

/**
 * Names the React runtime exports for wrapping components / context. `React.<name>`
 * member-expression callees are handled by leaf comparison, so the set only contains the
 * bare identifier.
 */
export const REACT_CONTEXT_FACTORIES: ReadonlySet<string> = new Set(["createContext"])
export const REACT_FORWARD_REF_FACTORIES: ReadonlySet<string> = new Set(["forwardRef"])
export const REACT_MEMO_FACTORIES: ReadonlySet<string> = new Set(["memo"])

/**
 * Result of inspecting a `const X = <call>(...)` symbol. `null` when the RHS is not a
 * bare call-expression form the plugin recognizes.
 */
export interface WrapperCall {
  /** Callee text verbatim, e.g. `"createContext"` or `"React.forwardRef"`. */
  readonly callee: string
  /** Callee leaf (e.g. `"forwardRef"` from `"React.forwardRef"`). */
  readonly leaf: string
}

/**
 * Extract the outermost `call_expression` under `fullNode` and report its callee. The
 * outermost call wins because pre-order finds the wrapping `forwardRef(...)` before any
 * inner render-body call it contains.
 *
 * Returns `null` when `fullNode` has no call expression descendants (e.g. `const x = 1`,
 * `const y = obj.field`), or when the passed value is not a tree-sitter node.
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

/**
 * `true` when `call` is `createContext(...)` or `React.createContext(...)`. Both bare and
 * namespaced import forms are accepted — the leaf-name check is enough because
 * `createContext` is not a name React encourages redefining.
 */
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
