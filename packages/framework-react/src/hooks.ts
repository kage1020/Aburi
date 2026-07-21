import { anyCallCalleeMatches, asSyntaxNode } from "./ast"

/**
 * React custom hook naming convention: `use` followed immediately by a capital letter.
 * `use` alone or `useful` do NOT match — the capital-letter marker is the same rule
 * `eslint-plugin-react-hooks` uses to enforce the Rules of Hooks.
 */
export function matchesHookNaming(leaf: string): boolean {
  return /^use[A-Z]/.test(leaf)
}

/**
 * True when `body` contains at least one call whose callee's leaf identifier is a hook
 * name (`use[A-Z]...`). Used as a corroborating signal alongside naming: a `useFoo`
 * function that internally calls `useState` / `useEffect` gets a stronger `derivedBy`.
 *
 * A hook that only wraps non-hook logic still classifies as a hook by naming alone; this
 * function only adds an additional signal, it never gates classification.
 */
export function bodyCallsAnotherHook(body: unknown): boolean {
  const node = asSyntaxNode(body)
  if (node === null) return false
  return anyCallCalleeMatches(node, matchesHookNaming)
}
