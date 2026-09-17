import { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "./jsx"

/** Leaf starts with an uppercase ASCII letter — the same gate React uses to tell `<Foo />` from an HTML element. */
export function isPascalCase(leaf: string): boolean {
  if (leaf.length === 0) return false
  const first = leaf.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

/** `with` followed by a capital (`withRouter`); the capital rejects plain words like `within`. */
export function matchesHocNaming(leaf: string): boolean {
  return /^with[A-Z]/.test(leaf)
}

/**
 * True when the function actually **returns** `<X.Provider>`. Uses the returned element, not
 * any JSX descendant, so a helper JSX literal above the `return` does not shadow it.
 */
export function returnsContextProvider(body: unknown): boolean {
  return isProviderElementName(findReturnedJsxElementName(body))
}

/** Alias of `hasJsxReturn`: any JSX in the body counts. */
export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body)
}
