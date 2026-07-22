import {
  asSyntaxNode,
  calleeLeaf,
  calleeText,
  findFirstDescendantOfType,
  type SyntaxNode,
} from "./ast"

/**
 * Factory names that produce an Express Router instance. `Router` covers both the direct
 * `import { Router } from 'express'` form and the destructured `const { Router } = express`
 * form; the member-form (`express.Router()`) is handled by inspecting the full callee text.
 */
export const EXPRESS_ROUTER_FACTORIES: ReadonlySet<string> = new Set(["Router"])

export interface RouterCall {
  /** Full callee text as written in source: "Router" or "express.Router". */
  readonly callee: string
  /** Rightmost identifier segment: always "Router" for a match. */
  readonly leaf: string
}

/**
 * Detect a top-level `const x = Router()` / `const x = express.Router()` init by walking
 * into the variable declarator's initializer. Returns null when the initializer is not a
 * call at all or when the callee is not `Router` at its leaf.
 */
export function extractRouterCall(fullNode: unknown): RouterCall | null {
  const node = asSyntaxNode(fullNode)
  if (node === null) return null
  const call = findFirstDescendantOfType(node, "call_expression")
  if (call === null) return null
  const callee = calleeText(call)
  if (callee === null) return null
  const leaf = calleeLeaf(callee)
  if (!EXPRESS_ROUTER_FACTORIES.has(leaf)) return null
  // Reject `RouterFactory.build()` accidents by requiring the leaf itself to be Router —
  // already checked above. The full text (e.g. `express.Router`) is preserved for
  // derivedBy so the plugin's output distinguishes the two calling styles.
  return { callee, leaf }
}

/**
 * Descend into the tree looking for the call that classifies as a Router construction.
 * Used by tests only; production code always drives through `extractRouterCall`.
 */
export function isRouterCall(node: SyntaxNode): boolean {
  if (node.type !== "call_expression") return false
  const callee = calleeText(node)
  if (callee === null) return false
  return EXPRESS_ROUTER_FACTORIES.has(calleeLeaf(callee))
}
