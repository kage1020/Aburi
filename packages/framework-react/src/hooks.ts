import { anyCallCalleeMatches, asSyntaxNode } from "@aburi/core"

/** `use` followed by a capital (`useState`), the same rule `eslint-plugin-react-hooks` enforces; `useful` does not match. */
export function matchesHookNaming(leaf: string): boolean {
  return /^use[A-Z]/.test(leaf)
}

export function bodyCallsAnotherHook(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return anyCallCalleeMatches(node, matchesHookNaming)
}
