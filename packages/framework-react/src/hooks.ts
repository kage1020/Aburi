import { anyCallCalleeMatches, asSyntaxNode } from "@aburi/core"

/** The rule `eslint-plugin-react-hooks` enforces. */
export function matchesHookNaming(leaf: string): boolean {
  return /^use[A-Z]/.test(leaf)
}

export function bodyCallsAnotherHook(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return anyCallCalleeMatches(node, matchesHookNaming)
}
