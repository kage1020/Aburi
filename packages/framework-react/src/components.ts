import { findFirstJsxElementName, hasJsxReturn, isProviderElementName } from "./jsx"

/**
 * React function component naming convention: the leaf identifier begins with an
 * uppercase ASCII letter. The uppercase gate is what React itself uses to decide whether
 * to treat `<Foo />` as a component-call versus an HTML element; matching the runtime
 * here keeps the classifier consistent.
 */
export function isPascalCase(leaf: string): boolean {
  if (leaf.length === 0) return false
  const first = leaf.charCodeAt(0)
  return first >= 0x41 && first <= 0x5a
}

/**
 * Higher-order component naming convention: leaf starts with `with` immediately followed
 * by a capital letter (`withRouter`, `withAuth`). The uppercase-after-`with` guard rejects
 * plain english like `within`, `without`.
 */
export function matchesHocNaming(leaf: string): boolean {
  return /^with[A-Z]/.test(leaf)
}

/**
 * True when `body` returns JSX whose first element is `X.Provider` — a member expression
 * whose final segment is `Provider`. A bare `<Provider>` is intentionally not matched:
 * without the namespace it could be any component named Provider, so treating it as a
 * context provider would over-classify.
 */
export function returnsContextProvider(body: unknown): boolean {
  const name = findFirstJsxElementName(body)
  if (name === null) return false
  return isProviderElementName(name)
}

/**
 * True when `body` returns JSX. Reuses `hasJsxReturn` from `./jsx` — kept here as a named
 * re-export so the components module reads as the component-classification surface without
 * callers needing to know that the JSX walker is a separate concern.
 */
export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body as never)
}
