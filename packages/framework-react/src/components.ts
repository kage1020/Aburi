import { findReturnedJsxElementName, hasJsxReturn, isProviderElementName } from "./jsx"

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
 * True when the function actually **returns** JSX whose element is `X.Provider`. Uses
 * `findReturnedJsxElementName` (not any JSX descendant) so a helper JSX literal defined
 * above the `return` statement does not shadow the returned Provider element.
 */
export function returnsContextProvider(body: unknown): boolean {
  return isProviderElementName(findReturnedJsxElementName(body))
}

/**
 * True when `body` contains JSX anywhere. Deliberately permissive — a component whose
 * top-level return is `null` but which produces JSX through an inline helper still counts
 * as JSX-producing for the fallback component classification. Provider detection uses the
 * stricter `returnsContextProvider` above instead.
 */
export function returnsJsx(body: unknown): boolean {
  return hasJsxReturn(body)
}
